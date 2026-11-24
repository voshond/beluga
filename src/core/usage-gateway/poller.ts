import type { UsageUpdate } from '../../agent/usage.js';
import { CODEX_USAGE_AGENT } from '../../agent/runtime/codex/rate-limits.js';
import { type AgentRef, CLAUDE_AGENT, type ProviderUsage } from '../../protocol.js';
import {
  USAGE_GATEWAY_POLL_MS,
  USAGE_GATEWAY_PROVIDERS,
  type UsageGatewayCheck,
  type UsageGatewayProvider,
  type UsageGatewayProviders,
  type UsageGatewayStatus,
  type UsageSource,
} from '../../shared/usage-gateway.js';
import { type UsageGatewayConfig, defaultUsageGatewayConfig, loadUsageGatewayConfig, saveUsageGatewayConfig, trimGatewayUrl, usageGatewayPath } from './config.js';
import { type GatewayProviderUsage, type GatewayUsage, GatewayUsageResponse, fromGatewayUsage } from './map.js';

export type GatewayFetch = (url: string, init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal }) => Promise<{ readonly status: number; readonly text: () => Promise<string> }>;

export type UsageGatewayDeps = {
  readonly report: (agent: AgentRef, update: UsageUpdate, at?: number) => void;
  readonly usages: () => readonly ProviderUsage[];
  readonly file?: string | null;
  readonly fetch?: GatewayFetch;
  readonly now?: () => number;
  readonly pollMs?: number;
};

export type UsageGatewayPatch = {
  readonly source?: UsageSource;
  readonly url?: string;
  readonly key?: string | null;
};

type ReadResult = { readonly ok: true; readonly usage: GatewayUsage } | { readonly ok: false; readonly error: string };

const TIMEOUT_MS = 12_000;

const AGENTS: Readonly<Record<UsageGatewayProvider, AgentRef>> = { claude: CLAUDE_AGENT, codex: CODEX_USAGE_AGENT };

const checksOf = (usage: GatewayUsage): UsageGatewayProviders => ({
  claude: { ok: Boolean(usage.claude.update), ...(usage.claude.error ? { error: usage.claude.error } : {}) },
  codex: { ok: Boolean(usage.codex.update), ...(usage.codex.error ? { error: usage.codex.error } : {}) },
});

export class UsageGateway {
  private config: UsageGatewayConfig;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private checkedAt?: number;
  private lastError?: string;
  private providers?: UsageGatewayProviders;

  constructor(private readonly deps: UsageGatewayDeps) {
    this.config = deps.file === null ? defaultUsageGatewayConfig() : loadUsageGatewayConfig(this.file);
  }

  private get file(): string {
    return this.deps.file ?? usageGatewayPath();
  }

  private readonly now = (): number => this.deps.now?.() ?? Date.now();

  start = (): void => this.schedule();

  stop = (): void => {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  };

  status = (): UsageGatewayStatus => ({
    source: this.config.source,
    url: this.config.url,
    hasKey: Boolean(this.config.key),
    ...(this.checkedAt !== undefined ? { checkedAt: this.checkedAt } : {}),
    ...(this.lastError ? { lastError: this.lastError } : {}),
    ...(this.providers ? { providers: this.providers } : {}),
  });

  configure = (patch: UsageGatewayPatch): UsageGatewayStatus => {
    const url = patch.url !== undefined ? trimGatewayUrl(patch.url) : this.config.url;
    const next: UsageGatewayConfig = { ...this.config, url, ...(patch.source ? { source: patch.source } : {}) };
    const keyStaysHome = url !== this.config.url && patch.key === undefined;
    if (patch.key === null || keyStaysHome) delete next.key;
    else if (patch.key !== undefined) next.key = patch.key;
    const moved = next.url !== this.config.url || next.key !== this.config.key || next.source !== this.config.source;
    const leaving = this.config.source === 'gateway' && next.source === 'local';
    this.config = next;
    this.save();
    if (!moved) return this.status();
    this.checkedAt = undefined;
    this.lastError = undefined;
    this.providers = undefined;
    if (leaving) this.unmark();
    this.schedule();
    return this.status();
  };

  check = async (draft?: { readonly url?: string; readonly key?: string }): Promise<UsageGatewayCheck> => {
    const url = draft?.url ? trimGatewayUrl(draft.url) : this.config.url;
    const key = draft?.key ?? (url === this.config.url ? this.config.key : undefined);
    if (!key) return { ok: false, error: 'Type the ai-gateway usage key first' };
    const result = await this.read(url, key);
    if (!result.ok) return result;
    if (this.config.source === 'gateway' && url === this.config.url && key === this.config.key) this.apply(result.usage);
    return { ok: true, providers: checksOf(result.usage) };
  };

  poll = (): Promise<void> => {
    this.polling ??= this.pollNow().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  };

  private schedule(): void {
    this.stop();
    if (this.config.source !== 'gateway') return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.pollMs ?? USAGE_GATEWAY_POLL_MS);
    this.timer.unref?.();
  }

  private async pollNow(): Promise<void> {
    if (this.config.source !== 'gateway') return;
    if (!this.config.key) {
      this.lastError = 'Add the ai-gateway usage key';
      return;
    }
    const result = await this.read(this.config.url, this.config.key);
    if (this.config.source !== 'gateway') return;
    this.checkedAt = this.now();
    if (!result.ok) {
      this.lastError = result.error;
      this.markStale(result.error);
      return;
    }
    this.apply(result.usage);
  }

  private apply(usage: GatewayUsage): void {
    this.checkedAt = this.now();
    this.lastError = undefined;
    this.providers = checksOf(usage);
    for (const provider of USAGE_GATEWAY_PROVIDERS) this.applyOne(provider, usage[provider]);
  }

  private applyOne(provider: UsageGatewayProvider, result: GatewayProviderUsage): void {
    const agent = AGENTS[provider];
    if (result.update) {
      this.deps.report(agent, { ...result.update, signedIn: true, via: 'gateway', error: result.error }, Math.min(result.fetchedAt ?? this.now(), this.now()));
      return;
    }
    const prev = this.usageOf(provider);
    if (!prev && !result.served) return;
    this.deps.report(agent, { via: 'gateway', error: result.error }, prev?.updatedAt ?? this.now());
  }

  private markStale(error: string): void {
    for (const provider of USAGE_GATEWAY_PROVIDERS) {
      const prev = this.usageOf(provider);
      if (prev) this.deps.report(AGENTS[provider], { via: 'gateway', error: `Couldn’t refresh from ai-gateway: ${error}`.slice(0, 200) }, prev.updatedAt);
    }
  }

  private unmark(): void {
    for (const provider of USAGE_GATEWAY_PROVIDERS) {
      const prev = this.usageOf(provider);
      if (prev?.via) this.deps.report(AGENTS[provider], { via: undefined, error: undefined }, prev.updatedAt);
    }
  }

  private usageOf(provider: UsageGatewayProvider): ProviderUsage | undefined {
    return this.deps.usages().find((u) => u.agent.runtime === AGENTS[provider].runtime);
  }

  private async read(url: string, key: string): Promise<ReadResult> {
    const fetcher: GatewayFetch = this.deps.fetch ?? fetch;
    try {
      const res = await fetcher(`${url}/gateway/usage`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': 'beluga' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: `ai-gateway rejected the key (HTTP ${res.status})` };
      if (res.status !== 200) return { ok: false, error: `ai-gateway returned HTTP ${res.status}` };
      const parsed = GatewayUsageResponse.safeParse(JSON.parse(await res.text()));
      if (!parsed.success) return { ok: false, error: 'ai-gateway’s answer has no providers' };
      return { ok: true, usage: fromGatewayUsage(parsed.data) };
    } catch (err) {
      if (err instanceof SyntaxError) return { ok: false, error: 'ai-gateway didn’t answer with JSON' };
      return { ok: false, error: `Couldn’t reach ai-gateway at ${url}` };
    }
  }

  private save(): void {
    if (this.deps.file === null) return;
    try {
      saveUsageGatewayConfig(this.config, this.file);
    } catch {
      return;
    }
  }
}

const gateways = new WeakMap<object, UsageGateway>();

export const maybeUsageGatewayOf = (session: object): UsageGateway | undefined => gateways.get(session);

export const usageGatewayOf = (session: object): UsageGateway => {
  const gateway = gateways.get(session);
  if (!gateway) throw new Error('The usage source is set up in the Beluga app (its daemon).');
  return gateway;
};

export const launchUsageGateway = (host: { readonly session: object; readonly report: UsageGatewayDeps['report']; readonly usages: UsageGatewayDeps['usages'] }): (() => void) => {
  const gateway = new UsageGateway({ report: host.report, usages: host.usages });
  gateways.set(host.session, gateway);
  gateway.start();
  return () => gateway.stop();
};
