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

  private async post(route: string, body: object): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    let res: Awaited<ReturnType<HonchoFetch>>;
    try {
      res = await this.doFetch(`${this.base}${route}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS) });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new HonchoError(name === 'TimeoutError' || name === 'AbortError' ? 'Honcho didn’t answer in time' : 'Couldn’t reach Honcho at that address', true);
    }
    if (res.ok) return;
    await res.text().catch(() => '');
    throw new HonchoError(describe(res.status), retryable(res.status));
  }

  private readonly ws = (): string => `/v3/workspaces/${encodeURIComponent(this.opts.workspace)}`;

  ensureWorkspace = (): Promise<void> => this.post('/v3/workspaces', { id: this.opts.workspace, metadata: { app: 'beluga' } });

  ensurePeer = (id: string, role: PeerRole): Promise<void> => this.post(`${this.ws()}/peers`, { id, metadata: { app: 'beluga', role } });

  ensureSession = (id: string, peers: readonly HonchoSessionPeer[], metadata: Readonly<Record<string, string>>): Promise<void> =>
    this.post(`${this.ws()}/sessions`, { id, metadata: { app: 'beluga', ...metadata }, peers: Object.fromEntries(peers.map((p) => [p.id, peerConfig(p.role)])) });

  addPeers = (session: string, peers: readonly HonchoSessionPeer[]): Promise<void> =>
    this.post(`${this.ws()}/sessions/${encodeURIComponent(session)}/peers`, Object.fromEntries(peers.map((p) => [p.id, peerConfig(p.role)])));

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

  test = async (): Promise<void> => {
    await this.ensureWorkspace();
    await this.ensurePeer(HONCHO_USER_PEER, 'user');
  };
}
