import type { HonchoPicture, HonchoReasoning, HonchoStatus, HonchoTestResult } from '../../shared/honcho.js';
import type { Store } from '../store.js';
import { HonchoClient, HonchoError, type HonchoFetch, type HonchoSessionPeer } from './client.js';
import { type HonchoConfig, defaultHonchoConfig, honchoPath, loadHonchoConfig, saveHonchoConfig, statusOf, trimUrl } from './config.js';
import { type Outgoing, pickOutgoing, sessionMetadata } from './filter.js';
import { HONCHO_USER_PEER } from './mapping.js';
import { HonchoQueue } from './queue.js';
import { type QueueTarget, honchoQueuePath, loadHonchoQueue, removeHonchoQueue, saveHonchoQueue } from './queue-file.js';

export type HonchoFeedDeps = {
  readonly store: Store;
  readonly sharedWith: (channel: string) => boolean;
  readonly file?: string | null;
  readonly queueFile?: string | null;
  readonly fetch?: HonchoFetch;
  readonly now?: () => number;
  readonly queue?: { readonly baseDelayMs?: number; readonly maxAttempts?: number };
};

export type HonchoPatch = {
  readonly enabled?: boolean;
  readonly url?: string;
  readonly apiKey?: string | null;
  readonly workspace?: string;
  readonly excluded?: readonly string[];
};

const SAVE_MS = 3000;
/** BLG-101: how long a run waits for the picture, how long the picture is reused, and how long a question may take. */
export const PICTURE_WAIT_MS = 2000;
export const PICTURE_TTL_MS = 5 * 60_000;
const PICTURE_RETRY_MS = 60_000;
const PICTURE_FETCH_MS = 15_000;
const ASK_TIMEOUT_MS = 90_000;
const ANSWER_MAX = 4000;

type CachedPicture = { readonly text: string; readonly at: number; readonly error?: string };
const QUEUE_SAVE_MS = 1000;

export class HonchoFeed {
  private config: HonchoConfig;
  private client?: HonchoClient;
  private workspaceReady = false;
  private readonly peersReady = new Set<string>();
  private readonly sessions = new Map<string, Set<string>>();
  private readonly queue: HonchoQueue;
  private off?: () => void;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private queueTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private picture?: CachedPicture;
  private pictureLoad?: Promise<CachedPicture>;

  constructor(private readonly deps: HonchoFeedDeps) {
    this.config = deps.file === null ? defaultHonchoConfig() : loadHonchoConfig(this.file);
    this.queue = new HonchoQueue({
      deliver: (batch) => this.deliver(batch),
      onSent: (count) => {
        this.saveQueueNow();
        if (this.config.enabled) this.change({ ...this.config, sent: this.config.sent + count, lastSentAt: this.now(), lastError: undefined });
      },
      onError: (message) => {
        if (this.config.enabled) this.change({ ...this.config, lastError: message.slice(0, 300) });
      },
      onChange: () => this.queueChanged(),
      ...(deps.queue ?? {}),
    });
  }

  private get file(): string {
    return this.deps.file ?? honchoPath();
  }

  private get queueFile(): string | null {
    if (this.deps.queueFile !== undefined) return this.deps.queueFile;
    return this.deps.file === null ? null : honchoQueuePath();
  }

  private get target(): QueueTarget {
    return { url: this.config.url, workspace: this.config.workspace };
  }

  private readonly now = (): number => this.deps.now?.() ?? Date.now();

  start = (): void => {
    this.restoreQueue();
    this.off = this.deps.store.onAction((a) => {
      if (!this.config.enabled) return;
      const item = pickOutgoing(a, { state: this.deps.store.getState(), excluded: this.config.excluded, since: this.config.since ?? Number.POSITIVE_INFINITY, sharedWith: this.deps.sharedWith });
      if (item) this.queue.push(item);
    });
  };

  stop = (): void => {
    this.off?.();
    this.stopped = true;
    this.queue.stop();
    this.saveQueueNow();
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveNow();
  };

  status = (): HonchoStatus => statusOf(this.config, this.queue.size);

  configure = (patch: HonchoPatch): HonchoStatus => {
    const url = patch.url !== undefined ? trimUrl(patch.url) : this.config.url;
    const turningOn = patch.enabled === true && !this.config.enabled;
    const next: HonchoConfig = {
      ...this.config,
      url,
      ...(patch.workspace !== undefined ? { workspace: patch.workspace } : {}),
      ...(patch.excluded !== undefined ? { excluded: [...new Set(patch.excluded)] } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(turningOn ? { since: this.now(), lastError: undefined } : {}),
    };
    const keyStaysHome = url !== this.config.url && patch.apiKey === undefined;
    if (patch.apiKey === null || keyStaysHome) delete next.apiKey;
    else if (patch.apiKey !== undefined) next.apiKey = patch.apiKey;
    const moved = next.url !== this.config.url || next.workspace !== this.config.workspace || next.apiKey !== this.config.apiKey;
    if (moved || !next.enabled) this.reset();
    this.config = next;
    this.saveNow();
    this.saveQueueNow();
    return this.status();
  };

  test = async (draft?: { readonly url?: string; readonly apiKey?: string }): Promise<HonchoTestResult> => {
    const url = draft?.url ? trimUrl(draft.url) : this.config.url;
    const apiKey = draft?.apiKey ?? (url === this.config.url ? this.config.apiKey : undefined);
    const client = new HonchoClient({
      url,
      ...(apiKey ? { apiKey } : {}),
      workspace: this.config.workspace,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
    try {
      await client.test();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof HonchoError ? err.message : 'Couldn’t reach Honcho at that address' };
    }
  };

  clientFor = (): HonchoClient | undefined => {
    if (!this.config.enabled) return undefined;
    this.client ??= new HonchoClient({
      url: this.config.url,
      ...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
      workspace: this.config.workspace,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
    return this.client;
  };

  /**
   * Honcho's picture of the user for a run (BLG-101): from the cache when fresh, otherwise fetched,
   * waiting `waitMs` at most (the fetch goes on and fills the cache for the next run). Undefined when
   * Honcho is off; empty when it holds nothing yet or can't be reached.
   */
  userPicture = async (waitMs = PICTURE_WAIT_MS): Promise<string | undefined> => {
    if (!this.clientFor()) return undefined;
    const cached = this.picture;
    if (cached && this.now() - cached.at < (cached.error ? PICTURE_RETRY_MS : PICTURE_TTL_MS)) return cached.text;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), waitMs);
      timer.unref();
    });
    const fresh = await Promise.race([this.loadPicture(), late]);
    clearTimeout(timer);
    return (fresh ?? cached)?.text ?? '';
  };

  /** Settings and the phone (`honcho.picture`): the picture fetched now, or why it couldn't be. */
  pictureView = async (): Promise<HonchoPicture> => {
    if (!this.clientFor()) return { enabled: false, text: '' };
    const p = await this.loadPicture();
    return { enabled: true, text: p.text, at: p.at, ...(p.error ? { error: p.error } : {}) };
  };

  /** An agent's question about the user (BLG-101), answered by Honcho's own model; throws a message the agent can read. */
  askAboutUser = async (question: string, level: HonchoReasoning = 'low'): Promise<string> => {
    const client = this.clientFor();
    if (!client) throw new HonchoError('Honcho is off: turn it on in Settings › Advanced › Honcho.', false);
    let answer: string;
    try {
      answer = await client.chat(HONCHO_USER_PEER, question, level, ASK_TIMEOUT_MS);
    } catch (err) {
      const why = err instanceof HonchoError ? err.message : 'Couldn’t reach Honcho';
      throw new HonchoError(`${why}. Honcho’s model may be busy: try again later, or go on without it.`, false);
    }
    const text = answer.trim();
    return text ? text.slice(0, ANSWER_MAX) : 'Honcho had no answer: it may not have learned enough about the user yet.';
  };

  private loadPicture(): Promise<CachedPicture> {
    const client = this.clientFor();
    if (!client) return Promise.resolve({ text: '', at: this.now() });
    if (this.pictureLoad) return this.pictureLoad;
    const load = client.representation(HONCHO_USER_PEER, PICTURE_FETCH_MS).then(
      (text): CachedPicture => ({ text: text.trim(), at: this.now() }),
      (err): CachedPicture => ({ text: this.picture?.text ?? '', at: this.now(), error: err instanceof HonchoError ? err.message : 'Couldn’t reach Honcho' }),
    );
    this.pictureLoad = load;
    return load.then((p) => {
      if (this.pictureLoad !== load) return p;
      this.pictureLoad = undefined;
      this.picture = p;
      return p;
    });
  }

  private reset(): void {
    this.client = undefined;
    this.picture = undefined;
    this.pictureLoad = undefined;
    this.workspaceReady = false;
    this.peersReady.clear();
    this.sessions.clear();
    this.queue.clear();
  }

  private async deliver(batch: readonly Outgoing[]): Promise<void> {
    const client = this.clientFor();
    if (!client) throw new HonchoError('Honcho is off', false);
    const first = batch[0]!;
    const conversation = first.conversation;
    if (!this.workspaceReady) {
      await client.ensureWorkspace();
      this.workspaceReady = true;
    }
    const user: HonchoSessionPeer = { id: HONCHO_USER_PEER, role: 'user' };
    const wanted: HonchoSessionPeer[] = [user, ...batch.map((b) => b.peer)].filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i);
    for (const p of wanted) {
      if (this.peersReady.has(p.id)) continue;
      await client.ensurePeer(p.id, p.role);
      this.peersReady.add(p.id);
    }
    const known = this.sessions.get(conversation.session);
    if (!known) {
      await client.ensureSession(conversation.session, wanted, sessionMetadata(conversation));
      this.sessions.set(conversation.session, new Set(wanted.map((p) => p.id)));
    } else {
      const missing = wanted.filter((p) => !known.has(p.id));
      if (missing.length) {
        await client.addPeers(conversation.session, missing);
        for (const p of missing) known.add(p.id);
      }
    }
    await client.addMessages(
      conversation.session,
      batch.map((b) => ({ peerId: b.peer.id, content: b.content, createdAt: b.ts, metadata: b.metadata })),
    );
  }

  private restoreQueue(): void {
    const file = this.queueFile;
    if (file === null) return;
    if (!this.config.enabled) return removeHonchoQueue(file);
    this.queue.restore(loadHonchoQueue(file, this.target));
    this.saveQueueNow();
  }

  private queueChanged(): void {
    if (this.queueFile === null) return;
    if (this.stopped) return this.saveQueueNow();
    if (this.queueTimer) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = undefined;
      this.saveQueueNow();
    }, QUEUE_SAVE_MS);
    this.queueTimer.unref?.();
  }

  private saveQueueNow(): void {
    const file = this.queueFile;
    if (file === null) return;
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = undefined;
    try {
      if (this.config.enabled) saveHonchoQueue(file, this.target, this.queue.waiting);
      else removeHonchoQueue(file);
    } catch {
      return;
    }
  }

  private change(next: HonchoConfig): void {
    this.config = next;
    if (this.deps.file === null || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, SAVE_MS);
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    if (this.deps.file === null) return;
    try {
      saveHonchoConfig(this.config, this.file);
    } catch {
      return;
    }
  }
}

const feeds = new WeakMap<object, HonchoFeed>();

export const maybeHonchoOf = (session: object): HonchoFeed | undefined => feeds.get(session);

export const honchoOf = (session: object): HonchoFeed => {
  const feed = feeds.get(session);
  if (!feed) throw new Error('Honcho is set up in the Beluga app (its daemon).');
  return feed;
};

export const launchHoncho = (host: { readonly session: object; readonly store: Store; readonly sharedWith: (channel: string) => boolean }): (() => void) => {
  const feed = new HonchoFeed({ store: host.store, sharedWith: host.sharedWith });
  feeds.set(host.session, feed);
  feed.start();
  return () => feed.stop();
};
