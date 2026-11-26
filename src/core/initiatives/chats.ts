import { randomBytes } from 'node:crypto';
import { mkdirSync, promises as fs, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dropAgentSession } from '../../agent/runtime/drop-session.js';
import type { AgentPlace } from '../../agent/types.js';
import { chatFits, chatLimitMessage } from '../../shared/chat-limit.js';
import { HistorySaver } from '../history-saver.js';
import { chosenAgent } from '../settings.js';
import { type LogItem, type Store, settleRun } from '../store.js';
import { CHECK_IN_CHAT, FIRST_INITIATIVE_CHAT, WATCH_CHAT, INITIATIVE_CHAT_ID, type InitiativeChats as ChatsState, initiativeChatChannel, initiativeChatOf } from './model.js';

export type InitiativeChatDeps = {
  readonly store: Store;
  readonly dir: string | null;
  readonly selfId: () => string;
  readonly folderOf: (slug: string) => string | undefined;
  readonly changed: (slug: string) => void;
  readonly now?: () => number;
  readonly claudeDir?: string;
  readonly codexDir?: string;
};

type Saved = {
  readonly sessionId?: string;
  readonly runtime?: string;
};

type ChatsFile = {
  readonly chats: ReadonlyArray<{ readonly id: string; readonly createdAt: number }>;
  readonly active: string;
};

const KEEP = 500;
const BUILT_IN: readonly string[] = [FIRST_INITIATIVE_CHAT, CHECK_IN_CHAT];
/** Chats made the first time something wakes them. */
const ON_WAKE: readonly string[] = [...BUILT_IN, WATCH_CHAT];

const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

const writeJson = (file: string, value: object): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
};

export class InitiativeChats {
  private readonly lists = new Map<string, ChatsFile>();
  private readonly sessions = new Map<string, Saved>();
  private readonly saver: HistorySaver | undefined;
  private readonly unsubscribe: () => void;
  private lastLog: readonly LogItem[] | undefined;

  constructor(private readonly deps: InitiativeChatDeps) {
    this.saver = deps.dir
      ? new HistorySaver({
          log: () => deps.store.getState().log,
          channels: () => new Set(this.allChannels()),
          idOf: (channel) => (this.knows(channel) ? channel : undefined),
          write: async (channel, items, current) => {
            const file = this.historyFile(channel);
            if (!file || !this.knows(channel)) return;
            mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            const tmp = `${file}.${process.pid}.tmp`;
            await fs.writeFile(tmp, `${JSON.stringify(items)}\n`, { mode: 0o600 });
            if (current() && this.knows(channel)) renameSync(tmp, file);
            else await fs.rm(tmp, { force: true });
          },
          writeSync: (channel, items) => {
            const file = this.historyFile(channel);
            if (file && this.knows(channel)) writeJson(file, items);
          },
          keep: KEEP,
        })
      : undefined;
    this.lastLog = deps.store.getState().log;
    this.unsubscribe = deps.store.subscribe(() => {
      const log = deps.store.getState().log;
      if (log === this.lastLog) return;
      this.lastLog = log;
      this.saver?.changed();
    });
  }

  stop(): void {
    this.unsubscribe();
    this.saver?.stop();
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private chatDir(slug: string, id: string): string | undefined {
    return this.deps.dir ? path.join(this.deps.dir, slug, 'chats', id) : undefined;
  }

  private historyFile(channel: string): string | undefined {
    const of = initiativeChatOf(channel);
    const dir = of ? this.chatDir(of.slug, of.chat) : undefined;
    return dir ? path.join(dir, 'history.json') : undefined;
  }

  private allChannels(): string[] {
    return [...this.lists].flatMap(([slug, list]) => list.chats.map((c) => initiativeChatChannel(slug, c.id)));
  }

  private knows(channel: string): boolean {
    const of = initiativeChatOf(channel);
    return Boolean(of && this.has(of.slug, of.chat));
  }

  has(slug: string, id: string): boolean {
    return Boolean(this.lists.get(slug)?.chats.some((c) => c.id === id));
  }

  load(slug: string): ChatsState {
    if (!this.lists.has(slug)) {
      const list = this.read(slug);
      this.lists.set(slug, list);
      for (const c of list.chats) {
        this.sessions.set(initiativeChatChannel(slug, c.id), this.readState(slug, c.id));
        this.loadHistory(slug, c.id);
      }
    }
    return this.state(slug);
  }

  /** What the chats outside `loaded` said, from disk (a search reads them; the log stays as it is). */
  savedChats(slug: string, loaded: ReadonlySet<string>): Array<{ readonly channel: string; readonly items: readonly LogItem[] }> {
    const list = this.lists.get(slug) ?? this.read(slug);
    return list.chats.flatMap((c) => {
      const channel = initiativeChatChannel(slug, c.id);
      const dir = this.chatDir(slug, c.id);
      if (loaded.has(channel) || !dir) return [];
      return [{ channel, items: readJson<LogItem[]>(path.join(dir, 'history.json'), []).map((l) => ({ ...l, channel })) }];
    });
  }

  /** Bring a chat's saved messages back into the log when it has none there (a search hit opens it). */
  loadSaved(channel: string): void {
    const of = initiativeChatOf(channel);
    if (of && this.has(of.slug, of.chat) && !this.deps.store.getState().log.some((l) => l.channel === channel)) this.loadHistory(of.slug, of.chat);
  }

  forget(slug: string): void {
    const list = this.lists.get(slug);
    if (!list) return;
    for (const c of list.chats) this.sessions.delete(initiativeChatChannel(slug, c.id));
    this.lists.delete(slug);
  }

  state(slug: string): ChatsState {
    const list = this.lists.get(slug) ?? this.defaults();
    return { chats: list.chats.map((c) => ({ id: c.id, channel: initiativeChatChannel(slug, c.id), createdAt: c.createdAt })), active: list.active };
  }

  private defaults(): ChatsFile {
    const at = this.now;
    return { chats: BUILT_IN.map((id) => ({ id, createdAt: at })), active: FIRST_INITIATIVE_CHAT };
  }

  private read(slug: string): ChatsFile {
    const dir = this.deps.dir ? path.join(this.deps.dir, slug) : undefined;
    const listed = dir ? readJson<Partial<ChatsFile> | undefined>(path.join(dir, 'chats.json'), undefined) : undefined;
    const raw = Array.isArray(listed?.chats) ? listed.chats : [];
    const chats = raw
      .filter((c, i) => typeof c?.id === 'string' && INITIATIVE_CHAT_ID.test(c.id) && raw.findIndex((x) => x?.id === c.id) === i)
      .map((c) => ({ id: c.id, createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0 }));
    if (!chats.length) return this.defaults();
    const active = chats.some((c) => c.id === listed?.active) && listed?.active ? listed.active : chats[0]!.id;
    return { chats, active };
  }

  private readState(slug: string, id: string): Saved {
    const dir = this.chatDir(slug, id);
    if (!dir) return {};
    const saved = readJson<{ sessionId?: string; runtime?: string }>(path.join(dir, 'state.json'), {});
    return { ...(typeof saved.sessionId === 'string' ? { sessionId: saved.sessionId } : {}), ...(typeof saved.runtime === 'string' ? { runtime: saved.runtime } : {}) };
  }

  private loadHistory(slug: string, id: string): void {
    const channel = initiativeChatChannel(slug, id);
    const dir = this.chatDir(slug, id);
    const saved = dir ? readJson<LogItem[]>(path.join(dir, 'history.json'), []) : [];
    const live = this.deps.store.getState().log.filter((l) => l.channel === channel);
    const known = new Set(saved.map((l) => l.id));
    if (saved.length) this.deps.store.dispatch({ type: 'history', channel, items: [...saved.map(settleRun), ...live.filter((l) => !known.has(l.id))] });
    this.saver?.loaded(channel);
  }

  private save(slug: string, list: ChatsFile): void {
    this.lists.set(slug, list);
    if (this.deps.dir) writeJson(path.join(this.deps.dir, slug, 'chats.json'), list);
    this.deps.changed(slug);
  }

  private need(slug: string): ChatsFile {
    this.load(slug);
    return this.lists.get(slug)!;
  }

  newChat(slug: string): string {
    const list = this.need(slug);
    const limit = this.deps.store.getState().prefs.chatLimit;
    if (!chatFits(list.chats.length, limit)) throw new Error(chatLimitMessage(list.chats.length, limit, 'chats in this initiative'));
    let id = '';
    do id = randomBytes(5).toString('hex');
    while (this.has(slug, id) || BUILT_IN.includes(id));
    this.sessions.set(initiativeChatChannel(slug, id), {});
    this.save(slug, { chats: [...list.chats, { id, createdAt: this.now }], active: id });
    this.saver?.loaded(initiativeChatChannel(slug, id));
    return id;
  }

  openChat(slug: string, id: string): void {
    const list = this.need(slug);
    if (!this.has(slug, id)) throw new Error('That chat was deleted');
    if (list.active !== id) this.save(slug, { ...list, active: id });
  }

  async deleteChat(slug: string, id: string): Promise<void> {
    const list = this.need(slug);
    const at = list.chats.findIndex((c) => c.id === id);
    if (at < 0) return;
    const channel = initiativeChatChannel(slug, id);
    const { sessionId, runtime } = this.sessions.get(channel) ?? {};
    const rest = list.chats.filter((c) => c.id !== id);
    const chats = rest.length ? rest : [{ id: FIRST_INITIATIVE_CHAT, createdAt: this.now }];
    const active = list.active !== id && rest.length ? list.active : chats[Math.min(at, chats.length - 1)]!.id;
    this.sessions.delete(channel);
    this.lists.set(slug, { chats, active });
    this.deps.store.dispatch({ type: 'clear', channel });
    this.deps.store.dispatch({ type: 'context_reset', channel });
    const dir = this.chatDir(slug, id);
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    const cwd = this.deps.folderOf(slug);
    if (sessionId && cwd) await dropAgentSession(cwd, sessionId, runtime, { ...(this.deps.claudeDir ? { claude: this.deps.claudeDir } : {}), ...(this.deps.codexDir ? { codex: this.deps.codexDir } : {}) });
    for (const c of chats) if (!this.sessions.has(initiativeChatChannel(slug, c.id))) this.sessions.set(initiativeChatChannel(slug, c.id), {});
    this.save(slug, { chats, active });
  }

  /** A chat something wakes (Check-in, Follow-ups) is listed before it's woken: a sentinel only wakes a chat it can find. False: not one of those. */
  ensure(slug: string, id: string): boolean {
    if (!ON_WAKE.includes(id)) return this.has(slug, id);
    const list = this.need(slug);
    if (!this.has(slug, id)) this.save(slug, { ...list, chats: [...list.chats, { id, createdAt: this.now }] });
    return true;
  }

  /** `fresh`: a new session, not the saved one (a check-in or a follow-up look starts from the folder, not the last run). */
  place(channel: string, from: string, opts: { readonly fresh?: boolean } = {}): AgentPlace | undefined {
    const of = initiativeChatOf(channel);
    if (!of || from !== this.deps.selfId()) return undefined;
    const cwd = this.deps.folderOf(of.slug);
    if (!cwd || !this.ensure(of.slug, of.chat)) return undefined;
    const agent = chosenAgent(this.deps.store.getState().prefs);
    const was = opts.fresh ? undefined : this.sessions.get(channel);
    const resume = (was?.runtime ?? 'claude') === agent.runtime ? was?.sessionId : undefined;
    if (opts.fresh) this.deps.store.dispatch({ type: 'context_reset', channel });
    return {
      cwd,
      additionalDirectories: [],
      autoEdit: true,
      agent,
      ...(resume ? { resume } : {}),
      onSession: (next) => {
        if (!this.has(of.slug, of.chat) || next === this.sessions.get(channel)?.sessionId) return;
        const saved = { sessionId: next, runtime: agent.runtime };
        this.sessions.set(channel, saved);
        const dir = this.chatDir(of.slug, of.chat);
        if (dir) writeJson(path.join(dir, 'state.json'), saved);
      },
    };
  }
}
