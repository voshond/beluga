import { z } from 'zod';
import type { UsageUpdate } from '../../agent/usage.js';
import { fromPercent, toMs } from '../../agent/runtime/claude/usage.js';
import { fromRateLimits } from '../../agent/runtime/codex/rate-limits.js';
import type { UsageGatewayProvider } from '../../shared/usage-gateway.js';

const Num = z.number().nullish().catch(null);

const ClaudeWindow = z.object({ utilization: Num, resets_at: z.string().nullish().catch(null) }).nullish().catch(null);

const ClaudeUsage = z.object({ five_hour: ClaudeWindow, seven_day: ClaudeWindow });

const CodexWindow = z.object({ usedPercent: Num, windowDurationMins: Num, resetsAt: Num }).nullish().catch(null);

const CodexUsage = z.object({ rateLimits: z.object({ primary: CodexWindow, secondary: CodexWindow, planType: z.string().nullish().catch(null) }).nullish().catch(null) });

const entryOf = <T extends z.ZodType>(usage: T) => z.object({ fetchedAt: Num, usage: usage.nullish().catch(null), error: z.string().nullish().catch(null) }).nullish().catch(null);

export const GatewayUsageResponse = z.object({
  providers: z.object({ claude: entryOf(ClaudeUsage), codex: entryOf(CodexUsage) }),
});

export type GatewayUsageResponse = z.infer<typeof GatewayUsageResponse>;

export type GatewayProviderUsage = { readonly update?: UsageUpdate; readonly error?: string; readonly fetchedAt?: number; readonly served: boolean };

export type GatewayUsage = Readonly<Record<UsageGatewayProvider, GatewayProviderUsage>>;

const NAMES: Readonly<Record<UsageGatewayProvider, string>> = { claude: 'Claude', codex: 'Codex' };

type ClaudeWindowRaw = z.infer<typeof ClaudeWindow>;

const claudeWindow = (w: ClaudeWindowRaw) => {
  const pct = fromPercent(w?.utilization);
  if (pct === undefined) return undefined;
  const resetsAt = toMs(w?.resets_at);
  return { pct, ...(resetsAt ? { resetsAt } : {}) };
};

const claudeUpdate = (usage: z.infer<typeof ClaudeUsage>): UsageUpdate | undefined => {
  const fiveHour = claudeWindow(usage.five_hour);
  const week = claudeWindow(usage.seven_day);
  if (!fiveHour && !week) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(week ? { week } : {}) };
};

const codexUpdate = (usage: z.infer<typeof CodexUsage>): UsageUpdate | undefined => fromRateLimits(usage.rateLimits);

const cleanError = (error: string | null | undefined): string | undefined => {
  const text = error?.trim();
  return text ? text.slice(0, 200) : undefined;
};

const providerOf = <U>(provider: UsageGatewayProvider, entry: { fetchedAt?: number | null; usage?: U | null; error?: string | null } | null | undefined, map: (usage: U) => UsageUpdate | undefined): GatewayProviderUsage => {
  const name = NAMES[provider];
  if (!entry) return { served: false, error: `${name} usage is not enabled on ai-gateway` };
  const error = cleanError(entry.error);
  const fetchedAt = toMs(entry.fetchedAt ?? undefined);
  const at = fetchedAt ? { fetchedAt } : {};
  if (!entry.usage) return { served: true, error: error ?? `ai-gateway has not collected ${name} usage yet`, ...at };
  const update = map(entry.usage);
  if (!update) return { served: true, error: error ?? `ai-gateway has no ${name} plan windows`, ...at };
  return { served: true, update, ...(error ? { error } : {}), ...at };
};

export const fromGatewayUsage = (response: GatewayUsageResponse): GatewayUsage => ({
  claude: providerOf('claude', response.providers.claude, claudeUpdate),
  codex: providerOf('codex', response.providers.codex, codexUpdate),
});
