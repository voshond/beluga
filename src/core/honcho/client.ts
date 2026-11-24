import { z } from 'zod';
import type { HonchoReasoning } from '../../shared/honcho.js';
import { HONCHO_USER_PEER, type PeerRole, peerConfig } from './mapping.js';

export type HonchoFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

export type HonchoClientOptions = {
  readonly url: string;
  readonly apiKey?: string;
  readonly workspace: string;
  readonly fetch?: HonchoFetch;
  readonly timeoutMs?: number;
};

export type HonchoMessage = {
  readonly peerId: string;
  readonly content: string;
  readonly createdAt: number;
  readonly metadata?: Readonly<Record<string, string>>;
};

export type HonchoSessionPeer = { readonly id: string; readonly role: PeerRole };

/** BLG-124: one thing Honcho concluded about a peer: from one message (`explicit`) or by dreaming over many (`deductive`, `inductive`). */
export type HonchoConclusion = { readonly id: string; readonly text: string; readonly level: string; readonly timesDerived: number };

const Conclusion = z.object({ id: z.string(), content: z.string(), level: z.string().nullish(), times_derived: z.number().nullish() });
const Conclusions = z.object({ items: z.array(Conclusion) });
const CreatedConclusions = z.array(z.object({ id: z.string() }));

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export class HonchoError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;
const MAX_CONTENT = 25_000;
const MAX_BATCH = 100;
const SEARCH_TOP_K = 20;
const SEARCH_MAX_CONCLUSIONS = 40;

const retryable = (status: number): boolean => status === 408 || status === 425 || status === 429 || status >= 500;

const describe = (status: number): string => {
  if (status === 401 || status === 403) return 'Honcho refused the API key';
  if (status === 404) return 'Honcho isn’t at that address (no /v3 API there)';
  if (status === 422) return 'Honcho turned the request down as malformed';
  return `Honcho answered ${status}`;
};

export class HonchoClient {
  private readonly base: string;
  private readonly doFetch: HonchoFetch;

  constructor(private readonly opts: HonchoClientOptions) {
    this.base = opts.url.trim().replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  get workspace(): string {
    return this.opts.workspace;
  }

  private post(route: string, body: object, timeoutMs?: number): Promise<string> {
    return this.request('POST', route, body, timeoutMs);
  }

  private async request(method: 'POST' | 'DELETE', route: string, body?: object, timeoutMs = this.opts.timeoutMs ?? TIMEOUT_MS): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    let res: Awaited<ReturnType<HonchoFetch>>;
    try {
      res = await this.doFetch(`${this.base}${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new HonchoError(name === 'TimeoutError' || name === 'AbortError' ? 'Honcho didn’t answer in time' : 'Couldn’t reach Honcho at that address', true);
    }
    if (res.ok) return res.text().catch(() => '');
    await res.text().catch(() => '');
    throw new HonchoError(describe(res.status), retryable(res.status));
  }

  private readonly ws = (): string => `/v3/workspaces/${encodeURIComponent(this.opts.workspace)}`;

  private readonly field = async (route: string, body: object, key: string, timeoutMs?: number): Promise<string> => {
    const raw = await this.post(route, body, timeoutMs);
    let parsed: Record<string, string | null | undefined>;
    try {
      parsed = JSON.parse(raw) as Record<string, string | null | undefined>;
    } catch {
      throw new HonchoError('Honcho answered something that isn’t JSON', false);
    }
    const value = parsed[key];
    return typeof value === 'string' ? value : '';
  };

  ensureWorkspace = async (): Promise<void> => void (await this.post('/v3/workspaces', { id: this.opts.workspace, metadata: { app: 'beluga' } }));

  ensurePeer = async (id: string, role: PeerRole): Promise<void> => void (await this.post(`${this.ws()}/peers`, { id, metadata: { app: 'beluga', role } }));

  /**
   * BLG-101: what Honcho holds about a peer now, as text (no model call; empty until it has processed conversations).
   * BLG-122: with a query, curated around the conclusions closest to it, with the most frequent ones too.
   */
  representation = (peer: string, query?: string, timeoutMs?: number): Promise<string> =>
    this.field(
      `${this.ws()}/peers/${encodeURIComponent(peer)}/representation`,
      query ? { search_query: query, search_top_k: SEARCH_TOP_K, max_conclusions: SEARCH_MAX_CONCLUSIONS, include_most_frequent: true } : {},
      'representation',
      timeoutMs,
    );

  /** BLG-101: a question about a peer, answered by Honcho's own model (slow: seconds to a minute). */
  chat = (peer: string, query: string, reasoningLevel: HonchoReasoning, timeoutMs?: number): Promise<string> =>
    this.field(`${this.ws()}/peers/${encodeURIComponent(peer)}/chat`, { query, reasoning_level: reasoningLevel }, 'content', timeoutMs);

  ensureSession = async (id: string, peers: readonly HonchoSessionPeer[], metadata: Readonly<Record<string, string>>): Promise<void> =>
    void (await this.post(`${this.ws()}/sessions`, { id, metadata: { app: 'beluga', ...metadata }, peers: Object.fromEntries(peers.map((p) => [p.id, peerConfig(p.role)])) }));

  addPeers = async (session: string, peers: readonly HonchoSessionPeer[]): Promise<void> =>
    void (await this.post(`${this.ws()}/sessions/${encodeURIComponent(session)}/peers`, Object.fromEntries(peers.map((p) => [p.id, peerConfig(p.role)]))));

  addMessages = async (session: string, messages: readonly HonchoMessage[]): Promise<void> => {
    for (let i = 0; i < messages.length; i += MAX_BATCH) {
      const batch = messages.slice(i, i + MAX_BATCH).map((m) => ({
        peer_id: m.peerId,
        content: m.content.slice(0, MAX_CONTENT),
        created_at: new Date(m.createdAt).toISOString(),
        metadata: { app: 'beluga', ...(m.metadata ?? {}) },
      }));
      await this.post(`${this.ws()}/sessions/${encodeURIComponent(session)}/messages`, { messages: batch });
    }
  };

  /** BLG-124: conclusions about a peer, newest first, filtered as Honcho filters (`level`, …). */
  conclusions = async (peer: string, filters: Readonly<Record<string, string>> = {}, size = 50): Promise<HonchoConclusion[]> => {
    const raw = await this.post(`${this.ws()}/conclusions/list?size=${size}&reverse=true`, { filters: { observed_id: peer, ...filters } });
    const parsed = Conclusions.safeParse(parseJson(raw));
    if (!parsed.success) throw new HonchoError('Honcho answered conclusions in a shape Beluga doesn’t know', false);
    return parsed.data.items.map((c) => ({ id: c.id, text: c.content, level: c.level ?? 'explicit', timesDerived: c.times_derived ?? 1 }));
  };

  /** BLG-124: write conclusions a peer holds about itself (what the user approved), and answer their ids in order. */
  addConclusions = async (peer: string, texts: readonly string[]): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const raw = await this.post(`${this.ws()}/conclusions`, { conclusions: texts.slice(i, i + MAX_BATCH).map((content) => ({ content: content.slice(0, MAX_CONTENT), observer_id: peer, observed_id: peer })) });
      const parsed = CreatedConclusions.safeParse(parseJson(raw));
      if (!parsed.success) throw new HonchoError('Honcho answered conclusions in a shape Beluga doesn’t know', false);
      ids.push(...parsed.data.map((c) => c.id));
    }
    return ids;
  };

  /** BLG-124: forget one conclusion; one gone already is fine. */
  forgetConclusion = async (id: string): Promise<void> => {
    try {
      await this.request('DELETE', `${this.ws()}/conclusions/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof HonchoError && err.message === describe(404)) return;
      throw err;
    }
  };

  test = async (): Promise<void> => {
    await this.ensureWorkspace();
    await this.ensurePeer(HONCHO_USER_PEER, 'user');
  };
}
