import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentPlace } from '../../agent/types.js';
import type { SentinelDraft } from '../sentinel/model.js';
import type { Action, Store } from '../store.js';
import { InitiativeChats } from './chats.js';
import { folderOf, listSlugs, readFolder, readMemoryFile, scaffoldFolder, writeConfig, writeSuggestions, writeText } from './files.js';
import {
  CHECK_IN_CHAT,
  FIRST_INITIATIVE_CHAT,
  type InitiativeConfig,
  InitiativeConfigSchema,
  type InitiativeDraft,
  InitiativeDraftSchema,
  type InitiativePatch,
  InitiativePatchSchema,
  type InitiativeView,
  INITIATIVE_SLUG,
  initiativeChatChannel,
  initiativeChatOf,
  suggestionMessage,
  uniqueSlug,
} from './model.js';
import { CHECK_IN_PROMPT, type LinkedRepo, initiativeBrief } from './prompt.js';
import { type PushResult, commitFolder, dayOf, ensureRepo, pushIfTracked, unpushedCount } from './repo.js';

export type CheckInHost = {
  readonly create: (draft: SentinelDraft) => { readonly id: string };
  readonly exists: (id: string) => boolean;
  readonly pause: (id: string, paused: boolean) => void;
  readonly runNow: (id: string) => void;
  readonly remove: (id: string) => void;
};

export type InitiativesDeps = {
  readonly store: Store;
  readonly root: string;
  readonly dir: string | null;
  readonly selfId: () => string;
  readonly ask: (prompt: string, channel: string) => string | undefined;
  readonly checkIns?: () => CheckInHost | undefined;
  readonly commit?: boolean;
  readonly now?: () => number;
  readonly claudeDir?: string;
  readonly codexDir?: string;
};

export type InitiativeChatRun = {
  readonly place: AgentPlace;
  readonly brief: string;
};

type Local = {
  readonly checkIn?: string;
};

const FINAL_EVENTS: ReadonlySet<string> = new Set(['done', 'error', 'denied']);

const CHECK_IN_TRIGGER = { kind: 'schedule', every: 'week', at: '08:00', days: [1, 2, 3, 4, 5], missed: 'catch-up' } as const;

export class Initiatives {
  readonly chats: InitiativeChats;
  private readonly locals = new Map<string, Local>();
  private readonly offAction: () => void;
  private stopped = false;

  constructor(private readonly deps: InitiativesDeps) {
    this.chats = new InitiativeChats({
      store: deps.store,
      dir: deps.dir,
      selfId: deps.selfId,
      folderOf: (slug) => (this.known(slug) ? folderOf(deps.root, slug) : undefined),
      changed: (slug) => this.refresh(slug),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.claudeDir ? { claudeDir: deps.claudeDir } : {}),
      ...(deps.codexDir ? { codexDir: deps.codexDir } : {}),
    });
    this.offAction = deps.store.onAction((action) => this.onAction(action));
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    if (this.deps.commit) await ensureRepo(this.deps.root).catch(() => mkdirSync(this.deps.root, { recursive: true }));
    else mkdirSync(this.deps.root, { recursive: true });
    if (this.stopped) return;
    const items = listSlugs(this.deps.root).map((slug) => this.view(slug));
    this.deps.store.dispatch({ type: 'initiatives_init', state: { enabled: true, root: this.deps.root, items } });
    await this.pushPending().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.offAction();
    this.chats.stop();
  }

  private known(slug: string): boolean {
    return INITIATIVE_SLUG.test(slug) && listSlugs(this.deps.root).includes(slug);
  }

  private need(slug: string): InitiativeView {
    if (!this.known(slug)) throw new Error('There’s no such initiative');
    return this.view(slug);
  }

  private localFile(slug: string): string | undefined {
    return this.deps.dir ? path.join(this.deps.dir, slug, 'local.json') : undefined;
  }

  private local(slug: string): Local {
    const cached = this.locals.get(slug);
    if (cached) return cached;
    const file = this.localFile(slug);
    let read: Local = {};
    try {
      const raw: { checkIn?: string } = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
      read = typeof raw.checkIn === 'string' ? { checkIn: raw.checkIn } : {};
    } catch {
      read = {};
    }
    this.locals.set(slug, read);
    return read;
  }

  private saveLocal(slug: string, local: Local): void {
    this.locals.set(slug, local);
    const file = this.localFile(slug);
    if (file) writeText(file, `${JSON.stringify(local)}\n`);
  }

  view(slug: string): InitiativeView {
    const folder = readFolder(this.deps.root, slug);
    const config = folder.config;
    const chats = this.chats.load(slug);
    const checkIn = this.local(slug).checkIn;
    return {
      slug,
      folder: folder.folder,
      name: config?.name ?? slug,
      goal: config?.goal ?? '',
      status: config?.status ?? 'active',
      epics: config?.epics ?? [],
      slackChannels: config?.slackChannels ?? [],
      docs: config?.docs ?? [],
      repos: config?.repos ?? [],
      calendarMatch: config?.calendarMatch ?? '',
      people: config?.people ?? [],
      ...(folder.progress ? { progress: folder.progress } : {}),
      suggestions: folder.suggestions,
      openDecisions: folder.openDecisions,
      recent: folder.recent,
      files: folder.files,
      ...(checkIn ? { checkIn } : {}),
      chats,
      ...(folder.trouble ? { trouble: folder.trouble } : {}),
    };
  }

  refresh(slug: string): void {
    if (this.stopped || !this.known(slug)) return;
    this.deps.store.dispatch({ type: 'initiative_put', item: this.view(slug) });
  }

  private config(slug: string): InitiativeConfig {
    const folder = readFolder(this.deps.root, slug);
    if (!folder.config) throw new Error(`Fix ${slug}/initiative.json first: ${folder.trouble ?? 'it is missing'}`);
    return folder.config;
  }

  private async commit(slug: string, message: string): Promise<void> {
    if (!this.deps.commit) return;
    try {
      await commitFolder(this.deps.root, slug, message, (result) => this.pushed(result));
    } catch {
      return;
    }
  }

  private pushed(result: PushResult): void {
    if (this.stopped) return;
    const was = this.deps.store.getState().initiatives.backup;
    if (result.ok) {
      if (was) this.deps.store.dispatch({ type: 'initiatives_backup' });
      return;
    }
    this.deps.store.dispatch({ type: 'initiatives_backup', backup: { since: was?.since ?? this.now, error: result.error } });
  }

  private async pushPending(): Promise<void> {
    if (!this.deps.commit || !(await unpushedCount(this.deps.root))) return;
    const result = await pushIfTracked(this.deps.root);
    if (result) this.pushed(result);
  }

  private checkInDraft(slug: string, name: string): SentinelDraft {
    return {
      name: `${name} check-in`.slice(0, 80),
      icon: 'calendar',
      projectId: null,
      trigger: CHECK_IN_TRIGGER,
      steps: [{ kind: 'chat', to: `${this.deps.selfId()}/${initiativeChatChannel(slug, CHECK_IN_CHAT)}`, text: CHECK_IN_PROMPT }],
      access: 'look',
    };
  }

  private makeCheckIn(slug: string, name: string): string | undefined {
    const host = this.deps.checkIns?.();
    if (!host) return undefined;
    const made = host.create(this.checkInDraft(slug, name));
    this.saveLocal(slug, { ...this.local(slug), checkIn: made.id });
    return made.id;
  }

  async create(draft: InitiativeDraft): Promise<{ readonly slug: string }> {
    const parsed = InitiativeDraftSchema.parse(draft);
    const slug = uniqueSlug(parsed.name, new Set(listSlugs(this.deps.root)));
    const config = InitiativeConfigSchema.parse({ ...parsed, status: 'active', createdAt: new Date(this.now).toISOString() });
    scaffoldFolder(this.deps.root, slug, config, dayOf(this.now));
    this.chats.load(slug);
    try {
      this.makeCheckIn(slug, config.name);
    } catch {
      this.saveLocal(slug, {});
    }
    await this.commit(slug, `${slug}: created`);
    this.refresh(slug);
    return { slug };
  }

  async update(slug: string, patch: InitiativePatch): Promise<InitiativeView> {
    this.need(slug);
    const parsed = InitiativePatchSchema.parse(patch);
    const next = InitiativeConfigSchema.parse({ ...this.config(slug), ...parsed });
    writeConfig(this.deps.root, slug, next);
    await this.commit(slug, `${slug}: updated`);
    this.refresh(slug);
    return this.view(slug);
  }

  async archive(slug: string): Promise<void> {
    const item = this.need(slug);
    if (item.checkIn) this.setCheckIn(slug, false);
    await this.update(slug, { status: 'archived' });
  }

  async setRepo(slug: string, repo: string, linked: boolean): Promise<InitiativeView> {
    const config = this.config(slug);
    const repos = linked ? [...config.repos.filter((r) => r !== repo), repo] : config.repos.filter((r) => r !== repo);
    return this.update(slug, { repos });
  }

  setCheckIn(slug: string, on: boolean): void {
    const item = this.need(slug);
    const host = this.deps.checkIns?.();
    if (!host) throw new Error('Check-ins need the Beluga app (its Sentinel)');
    const id = item.checkIn && host.exists(item.checkIn) ? item.checkIn : this.makeCheckIn(slug, item.name);
    if (id) host.pause(id, !on);
    this.refresh(slug);
  }

  checkInNow(slug: string): { readonly channel: string } {
    const item = this.need(slug);
    const channel = initiativeChatChannel(slug, CHECK_IN_CHAT);
    const host = this.deps.checkIns?.();
    if (host && item.checkIn && host.exists(item.checkIn)) {
      host.runNow(item.checkIn);
      return { channel };
    }
    if (this.deps.ask(CHECK_IN_PROMPT, channel) === undefined) throw new Error('The check-in could not start');
    return { channel };
  }

  async resolveSuggestion(slug: string, id: number, decision: 'approve' | 'dismiss'): Promise<{ readonly channel?: string }> {
    const item = this.need(slug);
    const suggestion = item.suggestions.find((s) => s.id === id);
    if (!suggestion) throw new Error('That suggestion is gone');
    if (suggestion.state !== 'open') throw new Error(`That suggestion was already ${suggestion.state}`);
    const resolvedAt = new Date(this.now).toISOString();
    const state = decision === 'approve' ? 'approved' : 'dismissed';
    writeSuggestions(this.deps.root, slug, item.suggestions.map((s) => (s.id === id ? { ...s, state, resolvedAt } : s)));
    await this.commit(slug, `${slug}: suggestion ${id} ${state}`);
    this.refresh(slug);
    if (decision === 'dismiss') return {};
    const active = item.chats.active === CHECK_IN_CHAT ? FIRST_INITIATIVE_CHAT : item.chats.active;
    const channel = initiativeChatChannel(slug, active);
    if (this.deps.ask(suggestionMessage(suggestion), channel) === undefined) throw new Error('The chat could not take it now');
    return { channel };
  }

  readFile(slug: string, rel: string): { readonly name: string; readonly text: string; readonly cut: boolean } {
    this.need(slug);
    return readMemoryFile(this.deps.root, slug, rel);
  }

  chatNew(slug: string): { readonly id: string; readonly channel: string } {
    this.need(slug);
    const id = this.chats.newChat(slug);
    return { id, channel: initiativeChatChannel(slug, id) };
  }

  chatOpen(slug: string, id: string): void {
    this.need(slug);
    this.chats.openChat(slug, id);
  }

  async chatDelete(slug: string, id: string): Promise<void> {
    this.need(slug);
    if (id === CHECK_IN_CHAT) throw new Error('The Check-in chat stays: the check-in wakes it');
    await this.chats.deleteChat(slug, id);
  }

  repos(item: Pick<InitiativeView, 'repos'>): LinkedRepo[] {
    const projects = this.deps.store.getState().projects;
    return item.repos.map((repo) => {
      const project = projects.find((p) => p.id === repo || p.name === repo);
      return project ? { name: project.name, ...(project.root ? { root: project.root } : {}) } : { name: repo };
    });
  }

  chatRun(channel: string, from: string): InitiativeChatRun | undefined {
    const of = initiativeChatOf(channel);
    if (!of || !this.known(of.slug)) return undefined;
    const place = this.chats.place(channel, from);
    if (!place) return undefined;
    const item = this.view(of.slug);
    const brief = readFolder(this.deps.root, of.slug).brief;
    return { place, brief: initiativeBrief(item, brief, this.repos(item), of.chat) };
  }

  private onAction(action: Action): void {
    if (action.type !== 'agent_event' || !FINAL_EVENTS.has(action.event)) return;
    const of = initiativeChatOf(action.channel);
    if (!of || !this.known(of.slug)) return;
    const message = of.chat === CHECK_IN_CHAT ? `${of.slug}: check-in ${dayOf(this.now)}` : `${of.slug}: chat ${dayOf(this.now)}`;
    void this.commit(of.slug, message).then(() => this.refresh(of.slug));
  }
}
