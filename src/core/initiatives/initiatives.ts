import { STEERED_IN } from '../../shared/claude-notices.js';
import { isDeepStrictEqual } from 'node:util';
import { boundInput, type StepRecord } from '../../shared/steps.js';
import type { PeopleEnrichRequest } from '../../agent/people-enricher.js';
import { PeopleEnricher } from './enricher.js';
import type { EnrichField, EnrichProposal } from './enrichment.js';
import { type Fetcher, PeopleAvatars } from './people-avatars.js';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentPlace, InitiativeQuestionTools } from '../../agent/types.js';
import type { ScheduleTrigger, SentinelDraft } from '../sentinel/model.js';
import { formatBytes } from '../../shared/format.js';
import { isSecretPath } from '../shares.js';
import type { Action, LogItem, Store } from '../store.js';
import { initiativeChatPlace } from './chat-ref.js';
import { type AudienceDraft, AudienceDraftSchema } from './audience.js';
import { InitiativeChats } from './chats.js';
import { keepProposal, readDirectory, removePersonFile, writePerson } from './directory.js';
import { PEOPLE_DIR, type Person, type PersonDraft } from './people.js';
import { PEOPLE_PASS } from './people-prompt.js';
import { findingTitle, readDiscovery, sizingFiles } from './discovery.js';
import { type ArtifactAbout, type DiscoveryStep, DiscoveryStepSchema, proposedEpicKeys } from './discovery-model.js';
import { discoveryStepPrompt } from './discovery-prompt.js';
import { addTimeline, artifactPath, folderOf, keepArtifactFile, listSlugs, readFolder, readMemoryFile, scaffoldFolder, writeArtifacts, writeConfig, writeOutbox, writeSuggestions, writeTasks, writeText, writeUpdates } from './files.js';
import {
  ARTIFACT_KEEP_MAX,
  type ArtifactRead,
  ArtifactSchema,
  artifactKindOf,
  CHECK_IN_CHAT,
  type CheckInSchedule,
  CheckInScheduleSchema,
  FIRST_INITIATIVE_CHAT,
  type GoalRefine,
  GoalRefineSchema,
  type InitiativeConfig,
  InitiativeConfigSchema,
  type InitiativeDraft,
  InitiativeDraftSchema,
  type InitiativePatch,
  InitiativePatchSchema,
  type InitiativeStatus,
  type InitiativeView,
  INITIATIVE_SLUG,
  initiativeChatChannel,
  initiativeChatOf,
  isSendingTool,
  matchesDraft,
  type OutboxDraft,
  type OutboxTarget,
  sameKeys,
  sendDraftMessage,
  targetWords,
  clarifyMessage,
  decisionMessage,
  DRAFT_KIND_WORDS,
  isSentTarget,
  suggestionMessage,
  textMaxOf,
  taskMessage,
  uniqueSlug,
} from './model.js';
import { CHECK_IN_PROMPT, CHECK_IN_WAKE, type LinkedRepo, checkInPromptFor, TASKS_PROMPT, TICKETS_PROMPT, initiativeBrief } from './prompt.js';
import { type PushResult, commitFolder, dayOf, ensureRepo, pushIfTracked, unpushedCount } from './repo.js';
import { UPDATES_DIR, UpdateRecordSchema, audienceIdOf, ticketMarks } from './updates.js';
import { draftUpdatePrompt } from './updates-prompt.js';
import { InitiativeWatches, type WatchHost } from './watching.js';
import { WATCH_CHAT, type Watch, type WatchDraft } from './watches.js';
import { RiskKeeper } from './risk-keeper.js';
import type { RiskDraft } from './risks.js';
import type { SuccessDefineRequest } from '../../agent/success-definer.js';
import type { SuccessDefinition, SuccessDraft, SuccessProposal, SuccessProposalInput } from './success.js';
import { captureQuestionAnswers, isQuestionTarget, questionDecisions, questionsOf, removeQuestionRecord, saveQuestionRecord } from './question-records.js';
import { type Question, type QuestionDraft, isRetired } from './questions.js';
import { deliveryOf, type Delivery } from './delivery.js';
import { InitiativeSuccess, type SuccessHost } from './success-service.js';

export type CheckInHost = {
  readonly create: (draft: SentinelDraft) => { readonly id: string };
  readonly exists: (id: string) => boolean;
  readonly pause: (id: string, paused: boolean) => void;
  readonly runNow: (id: string) => void;
  readonly reschedule: (id: string, trigger: ScheduleTrigger) => void;
  readonly remove: (id: string) => void;
  /** Rewrites a sentinel's trigger and steps (the watch sentinel, re-armed for its next look). */
  readonly rewrite?: WatchHost['rewrite'];
};

export type InitiativesDeps = {
  readonly store: Store;
  readonly root: string;
  readonly dir: string | null;
  readonly selfId: () => string;
  readonly ask: (prompt: string, channel: string) => string | undefined;
  readonly checkIns?: () => CheckInHost | undefined;
  readonly refine?: (input: GoalRefine) => Promise<string | undefined>;
  readonly successHost?: () => SuccessHost | undefined;
  readonly defineSuccess?: (req: SuccessDefineRequest) => Promise<SuccessProposal | undefined>;
  readonly enrichPeople?: (req: PeopleEnrichRequest) => Promise<EnrichProposal[] | undefined>;
  /** Fetches a person's picture (tests hand in their own). */
  readonly fetcher?: Fetcher;
  readonly commit?: boolean;
  readonly now?: () => number;
  readonly claudeDir?: string;
  readonly codexDir?: string;
};

export type InitiativeChatRun = {
  readonly place: AgentPlace;
  readonly brief: string;
  readonly questions?: InitiativeQuestionTools;
  /** Denies a message sent outward that isn't a draft the user sent; lets that one through. */
  readonly vetTool: (toolName: string, input: Record<string, unknown>, toolUseId?: string) => string | undefined;
  /** The draft call vetTool just let through: the user already said Send, so no second card. */
  readonly preApproved: (toolName: string, input: Record<string, unknown>) => boolean;
  readonly onStep: (step: StepRecord) => void;
  readonly finish: () => void;
};

/** A draft the user sent: the one call it allows, kept here, never in a file the agent can write. */
type Send = { readonly slug: string; readonly id: number; readonly to: OutboxTarget; readonly text: string; readonly channel: string; requestId?: string };

const SEND_LOST = 'Beluga restarted before this was confirmed. Check the destination before sending again.';

const SENT_WORDS: Readonly<Record<OutboxTarget['kind'], string>> = { slack: 'a Slack message', jira: 'a Jira comment', confluence: 'a Confluence update', 'confluence-page': 'a Confluence page', prep: 'a prep sheet' };

export const OUTBOX_DENIED = 'In an initiative, messages go out through its outbox: write this as a draft in outbox.json, and the user sends it from the chat.';

/** A file a worktree's agent sends an initiative (report_to_initiative), with where it came from. */
export type ArtifactReport = {
  readonly file: string;
  readonly title: string;
  readonly why?: string;
  readonly ticket?: string;
  readonly worktree?: string;
  readonly project?: string;
  readonly from?: string;
  readonly about?: ArtifactAbout;
};

const IMAGE_READ_MAX = 15 * 1024 * 1024;

const MEDIA_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

type Local = {
  readonly checkIn?: string;
  readonly watch?: string;
};

const FINAL_EVENTS: ReadonlySet<string> = new Set(['done', 'error', 'denied']);

const CHECK_IN_TRIGGER: ScheduleTrigger = { kind: 'schedule', every: 'week', at: '08:00', days: [1, 2, 3, 4, 5], missed: 'catch-up' };

export class Initiatives {
  readonly chats: InitiativeChats;
  readonly watching: InitiativeWatches;
  private readonly risks: RiskKeeper;
  readonly success: InitiativeSuccess;
  private readonly enricher: PeopleEnricher;
  private readonly avatars: PeopleAvatars;
  private readonly locals = new Map<string, Local>();
  private readonly sends = new Map<string, Send>();
  private readonly sending = new Set<string>();
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
    this.watching = new InitiativeWatches({
      root: deps.root,
      now: () => this.now,
      selfId: deps.selfId,
      ask: deps.ask,
      host: () => {
        const host = deps.checkIns?.();
        return host?.rewrite ? { ...host, rewrite: host.rewrite } : undefined;
      },
      sentinel: (slug) => this.local(slug).watch,
      keepSentinel: (slug, id) => this.saveLocal(slug, { ...this.local(slug), watch: id }),
      ensureChat: (slug) => this.chats.ensure(slug, WATCH_CHAT),
      commit: (slug, message) => this.commit(slug, message),
      refresh: (slug) => this.refresh(slug),
      about: (slug) => {
        const config = readFolder(deps.root, slug).config;
        return { name: config?.name ?? slug, active: Boolean(config) && config?.status !== 'archived' };
      },
    });
    this.risks = new RiskKeeper(deps.root, deps.dir);
    this.success = new InitiativeSuccess({ root: deps.root, host: () => deps.successHost?.(), ...(deps.defineSuccess ? { propose: deps.defineSuccess } : {}), now: () => this.now });
    this.enricher = new PeopleEnricher({
      dir: deps.dir,
      people: () => readDirectory(deps.root),
      projects: () => [...new Set(listSlugs(deps.root).flatMap((slug) => (readFolder(deps.root, slug).config?.epics ?? []).map((epic) => epic.split('-')[0]!)))],
      ...(deps.enrichPeople ? { enrich: deps.enrichPeople } : {}),
      save: (draft) => this.savePerson(draft),
      publish: (enrichment) => {
        if (!this.stopped) deps.store.dispatch({ type: 'initiatives_enrichment', enrichment });
      },
      now: () => this.now,
    });
    this.avatars = new PeopleAvatars(deps.dir ? path.join(deps.dir, 'avatars') : null, deps.fetcher);
    this.offAction = deps.store.onAction((action) => this.onAction(action));
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    if (this.deps.commit) await ensureRepo(this.deps.root).catch(() => mkdirSync(this.deps.root, { recursive: true }));
    else mkdirSync(this.deps.root, { recursive: true });
    if (this.stopped) return;
    for (const slug of listSlugs(this.deps.root)) this.failLostSends(slug);
    const items = listSlugs(this.deps.root).map((slug) => this.view(slug));
    const people = readDirectory(this.deps.root);
    this.deps.store.dispatch({ type: 'initiatives_init', state: { enabled: true, root: this.deps.root, items, people, enrichment: this.enricher.view, avatars: this.avatars.shas(people) } });
    void this.syncAvatars(people);
    await this.pushPending().catch(() => undefined);
    for (const item of items) await this.watching.sync(item.slug).catch(() => undefined);
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
      const raw: { checkIn?: string; watch?: string } = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
      read = { ...(typeof raw.checkIn === 'string' ? { checkIn: raw.checkIn } : {}), ...(typeof raw.watch === 'string' ? { watch: raw.watch } : {}) };
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
    const success = this.success.read(slug);
    const discovery = readDiscovery(folder.folder, config?.status ?? 'active');
    const questions = questionsOf(folder);
    const decisions = questionDecisions(folder);
    const waitingQuestions = questions.flatMap((question) => {
      if (question.answer || !question.waitingOn) return [];
      const waiting = folder.watches.some((watch) => watch.question === question.id && watch.state === 'watching');
      return waiting || !folder.questions.some((stored) => stored.id === question.id)
        ? question.waitingOn.split(',').map((person) => person.trim()).filter(Boolean).map((waitingOn) => ({ text: question.text, waitingOn }))
        : [];
    });
    return {
      slug,
      folder: folder.folder,
      name: config?.name ?? slug,
      goal: config?.goal ?? '',
      status: config?.status ?? 'active',
      epics: config?.epics ?? [],
      slack: config?.slack ?? [],
      docs: config?.docs ?? [],
      repos: config?.repos ?? [],
      meetings: config?.meetings ?? [],
      people: config?.people ?? [],
      audiences: config?.audiences ?? [],
      updates: folder.updates,
      ...(folder.progress ? { progress: folder.progress } : {}),
      ...(folder.tickets ? { tickets: folder.tickets } : {}),
      ...(folder.tasks ? { tasks: folder.tasks } : {}),
      suggestions: folder.suggestions,
      outbox: folder.outbox,
      watches: folder.watches,
      artifacts: folder.artifacts,
      risks: folder.risks,
      ...(discovery ? { discovery } : {}),
      timeline: folder.timeline,
      questions,
      ...(decisions ? { decisions } : {}),
      ...(waitingQuestions.length ? { waitingQuestions } : {}),
      files: folder.files,
      ...(checkIn ? { checkIn } : {}),
      ...(success.definition || success.shippedAt ? { success } : {}),
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

  private checkInDraft(slug: string, name: string, status: InitiativeStatus): SentinelDraft {
    this.chats.ensure(slug, CHECK_IN_CHAT);
    return {
      name: `${name} check-in`.slice(0, 80),
      icon: 'calendar',
      projectId: null,
      trigger: CHECK_IN_TRIGGER,
      steps: [{ kind: 'chat', to: `${this.deps.selfId()}/${initiativeChatChannel(slug, CHECK_IN_CHAT)}`, text: status === 'discovery' ? CHECK_IN_WAKE : CHECK_IN_PROMPT }],
      access: 'look',
    };
  }

  private makeCheckIn(slug: string, name: string, status: InitiativeStatus): string | undefined {
    const host = this.deps.checkIns?.();
    if (!host) return undefined;
    const made = host.create(this.checkInDraft(slug, name, status));
    this.saveLocal(slug, { ...this.local(slug), checkIn: made.id });
    return made.id;
  }

  private fetchTickets(slug: string): string | undefined {
    try {
      return this.deps.ask(TICKETS_PROMPT, initiativeChatChannel(slug, CHECK_IN_CHAT));
    } catch {
      return undefined;
    }
  }

  refreshTickets(slug: string): { readonly channel: string } {
    const item = this.need(slug);
    if (!item.epics.length) throw new Error('Link a Jira epic first: Edit… › Jira epics');
    if (this.fetchTickets(slug) === undefined) throw new Error('The ticket refresh could not start');
    return { channel: initiativeChatChannel(slug, CHECK_IN_CHAT) };
  }

  refreshTasks(slug: string): { readonly channel: string } {
    this.need(slug);
    const channel = initiativeChatChannel(slug, CHECK_IN_CHAT);
    if (this.deps.ask(TASKS_PROMPT, channel) === undefined) throw new Error('The task refresh could not start');
    return { channel };
  }

  /** The user ticks a task: it shows as on its way at once, and the chat completes (or reopens) it in Google. */
  async setTaskDone(slug: string, id: string, done: boolean): Promise<{ readonly channel: string }> {
    const item = this.need(slug);
    const task = item.tasks?.tasks.find((t) => t.id === id);
    if (!item.tasks || !task) throw new Error('That task is gone');
    if (task.done === done && !task.pending) throw new Error(done ? 'That task is already done' : 'That task is already open');
    writeTasks(this.deps.root, slug, { ...item.tasks, tasks: item.tasks.tasks.map((t) => (t.id === id ? { ...t, pending: done ? 'complete' : 'reopen' } : t)) });
    await this.commit(slug, `${slug}: task ${done ? 'ticked' : 'reopened'}`);
    this.refresh(slug);
    const channel = this.workChannel(item);
    if (this.deps.ask(taskMessage(task, done), channel) === undefined) throw new Error('The chat could not take it now');
    return { channel };
  }

  async refineGoal(input: GoalRefine): Promise<{ readonly goal: string }> {
    const parsed = GoalRefineSchema.parse(input);
    if (!parsed.name && !parsed.goal.trim() && !parsed.epics.length) throw new Error('Write a name, a few words on the goal or an epic key first');
    if (!this.deps.refine) throw new Error('Refining a goal needs an agent on this computer');
    const goal = await this.deps.refine(parsed).catch(() => undefined);
    if (!goal) throw new Error('Your agent could not draft a goal just now. Try again, or write it yourself.');
    return { goal };
  }

  async create(draft: InitiativeDraft, opts: { readonly quiet?: boolean } = {}): Promise<{ readonly slug: string }> {
    const parsed = InitiativeDraftSchema.parse(draft);
    const slug = uniqueSlug(parsed.name, new Set([...listSlugs(this.deps.root), PEOPLE_DIR]));
    const config = InitiativeConfigSchema.parse({ ...parsed, status: parsed.status ?? 'active', createdAt: new Date(this.now).toISOString() });
    scaffoldFolder(this.deps.root, slug, config, dayOf(this.now));
    this.chats.load(slug);
    try {
      this.makeCheckIn(slug, config.name, config.status);
    } catch {
      this.saveLocal(slug, {});
    }
    await this.commit(slug, `${slug}: created`);
    this.refresh(slug);
    if (config.epics.length && !opts.quiet) this.fetchTickets(slug);
    return { slug };
  }

  async update(slug: string, patch: InitiativePatch): Promise<InitiativeView> {
    this.need(slug);
    const parsed = InitiativePatchSchema.parse(patch);
    const was = this.config(slug);
    const next = InitiativeConfigSchema.parse({ ...was, ...parsed });
    writeConfig(this.deps.root, slug, next);
    if (was.status !== next.status) this.statusChanged(slug, was.status, next.status);
    await this.commit(slug, `${slug}: updated`);
    this.refresh(slug);
    if (next.epics.length && !sameKeys(was.epics, next.epics)) this.fetchTickets(slug);
    if (was.status !== next.status) await this.watching.sync(slug).catch(() => undefined);
    return this.view(slug);
  }

  /** Shipped: the ship date is noted and the check-in goes weekly (an outcome review); back to work, it goes back to weekdays. */
  private statusChanged(slug: string, was: InitiativeStatus, next: InitiativeStatus): void {
    this.success.statusChanged(slug, was, next);
    const weekly = next === 'shipped';
    if (weekly === (was === 'shipped') || next === 'archived') return;
    const host = this.deps.checkIns?.();
    const id = this.local(slug).checkIn;
    if (!host || !id || !host.exists(id)) return;
    host.reschedule(id, weekly ? { ...CHECK_IN_TRIGGER, days: [1] } : CHECK_IN_TRIGGER);
  }

  /** Your agent's proposal of what success means, with each query's first rows (nothing is saved yet). */
  async defineSuccess(slug: string): Promise<SuccessDraft> {
    const item = this.need(slug);
    return this.success.draft(item, this.repos(item));
  }

  /** The owner accepts a definition: kept in success.json, with its sentinel (paused when new) and its dashboard. */
  async acceptSuccess(slug: string, proposal: SuccessProposalInput): Promise<SuccessDefinition> {
    const definition = await this.success.accept(this.need(slug), proposal);
    await this.commit(slug, `${slug}: success defined`);
    this.refresh(slug);
    return definition;
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

  private checkInHost(item: InitiativeView): { readonly host: CheckInHost; readonly id: string | undefined } {
    const host = this.deps.checkIns?.();
    if (!host) throw new Error('Check-ins need the Beluga app (its Sentinel)');
    return { host, id: item.checkIn && host.exists(item.checkIn) ? item.checkIn : this.makeCheckIn(item.slug, item.name, item.status) };
  }

  setCheckIn(slug: string, on: boolean): void {
    const { host, id } = this.checkInHost(this.need(slug));
    if (id) host.pause(id, !on);
    this.refresh(slug);
  }

  setCheckInTime(slug: string, schedule: CheckInSchedule): void {
    const parsed = CheckInScheduleSchema.parse(schedule);
    const { host, id } = this.checkInHost(this.need(slug));
    if (!id) throw new Error('The check-in could not be made');
    host.reschedule(id, { ...CHECK_IN_TRIGGER, at: parsed.at, days: [...new Set(parsed.days)].sort((a, b) => a - b) });
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
    if (this.deps.ask(checkInPromptFor(item), channel) === undefined) throw new Error('The check-in could not start');
    return { channel };
  }

  /** A discovery step from the page (Size It, Draft PRD, Start Demo…): its prompt goes into the work chat, which does it and asks for anything outward. */
  discoveryStep(slug: string, input: DiscoveryStep): { readonly channel: string } {
    const step = DiscoveryStepSchema.parse(input);
    const item = this.need(slug);
    if (item.status !== 'discovery') throw new Error('That step is for an initiative in discovery');
    if (step.step === 'demo' && !item.repos.includes(step.repo)) throw new Error(`Link ${step.repo} first: Repos › +`);
    const channel = this.workChannel(item);
    if (this.deps.ask(discoveryStepPrompt(step), channel) === undefined) throw new Error('The chat could not take it now');
    return { channel };
  }

  /** Discovery is over: the epics the agent created (proposal.json) are linked and the initiative is active. */
  async promote(slug: string): Promise<InitiativeView> {
    const item = this.need(slug);
    if (item.status !== 'discovery') throw new Error('Only an initiative in discovery moves to delivery');
    const epics = [...new Set([...item.epics, ...proposedEpicKeys(item.discovery?.proposal)])].slice(0, 20);
    if (!epics.length) throw new Error('No epics yet: Propose Epics, approve creating them, then move it to delivery');
    addTimeline(this.deps.root, slug, `${dayOf(this.now)} [decision]: moved from discovery to delivery with ${epics.join(', ')}`);
    return this.update(slug, { status: 'active', epics });
  }

  /** Each finding the agent left in sizing/ becomes an artifact, moved out of there. */
  private async keepSizing(slug: string): Promise<void> {
    for (const file of sizingFiles(folderOf(this.deps.root, slug))) {
      await this.reportArtifact(slug, { file, title: findingTitle(file), why: 'A sizing finding, with its query', from: 'Size It', about: 'sizing' });
      rmSync(file, { force: true });
    }
  }

  /** Approve or dismiss a suggestion; `answer` is what the user decided, for a decision. */
  async resolveSuggestion(slug: string, id: number, decision: 'approve' | 'dismiss', answer?: string): Promise<{ readonly channel?: string }> {
    const item = this.need(slug);
    const suggestion = item.suggestions.find((s) => s.id === id);
    if (!suggestion) throw new Error('That suggestion is gone');
    if (suggestion.state !== 'open') throw new Error(`That suggestion was already ${suggestion.state}`);
    const resolvedAt = new Date(this.now).toISOString();
    const state = decision === 'approve' ? 'approved' : 'dismissed';
    const decided = decision === 'approve' && answer ? answer.trim() : undefined;
    writeSuggestions(this.deps.root, slug, item.suggestions.map((s) => (s.id === id ? { ...s, state, resolvedAt, ...(decided ? { answer: decided } : {}) } : s)));
    if (decision === 'approve' && suggestion.people?.length) return this.keepPeople(slug, id);
    await this.commit(slug, `${slug}: suggestion ${id} ${decided ? 'decided' : state}`);
    this.refresh(slug);
    if (decision === 'dismiss') return {};
    const channel = this.workChannel(item);
    if (this.deps.ask(decided ? decisionMessage(suggestion, decided) : suggestionMessage(suggestion), channel) === undefined) throw new Error('The chat could not take it now');
    return { channel };
  }

  async clarifySuggestion(slug: string, id: number): Promise<{ readonly channel: string }> {
    const item = this.need(slug);
    const suggestion = item.suggestions.find((s) => s.id === id);
    if (!suggestion) throw new Error('That suggestion is gone');
    if (suggestion.state !== 'open') throw new Error(`That suggestion was already ${suggestion.state}`);
    const channel = this.workChannel(item);
    if (this.deps.ask(clarifyMessage(suggestion), channel) === undefined) throw new Error('The chat could not take it now');
    const clarifiedAt = new Date(this.now).toISOString();
    writeSuggestions(this.deps.root, slug, item.suggestions.map((s) => (s.id === id ? { ...s, clarifiedAt } : s)));
    await this.commit(slug, `${slug}: suggestion ${id} clarifying`);
    this.refresh(slug);
    return { channel };
  }

  /** The user sends a draft (edited or not): the chat they are in is asked to post it, and only that call is allowed. */
  async sendDraft(slug: string, id: number, text: string, expectsReply?: boolean, chat?: string): Promise<{ readonly channel: string }> {
    const item = this.need(slug);
    const draft = this.openDraft(item, id);
    const to = draft.to;
    if (!isSentTarget(to)) throw new Error('A prep sheet is never sent: copy it into the meeting, then mark it Done');
    const final = text.trim();
    if (!final) throw new Error('Write the message first');
    if (final.length > textMaxOf(to)) throw new Error(`That is ${final.length} characters: a ${DRAFT_KIND_WORDS[to.kind]} takes ${textMaxOf(to)} at most`);
    const allowed = draft.to.kind === 'confluence-page' ? this.readFile(slug, draft.to.file).text : final;
    const key = `${slug}:${id}`;
    if (this.sending.has(key)) throw new Error('This draft is already on its way');
    const channel = this.workChannel(item, chat);
    const send: Send = { slug, id, to: draft.to, text: allowed, channel };
    this.sends.set(key, send);
    const edited = final !== draft.text.trim();
    this.putDraft(slug, item.outbox, id, (d) => {
      const { sentText: _sent, sendError: _error, ...rest } = d;
      return { ...rest, state: 'approved', ...(edited ? { sentText: final } : {}), ...(expectsReply === undefined ? {} : { expectsReply }) };
    });
    this.refresh(slug);
    send.requestId = this.deps.ask(sendDraftMessage({ id: draft.id, to }, final), channel);
    if (send.requestId === undefined) {
      this.sends.delete(key);
      throw new Error('The chat could not take it now');
    }
    await this.commit(slug, `${slug}: draft ${id} approved`);
    return { channel };
  }

  async discardDraft(slug: string, id: number): Promise<void> {
    const item = this.need(slug);
    const draft = this.openDraft(item, id);
    if (this.sending.has(`${slug}:${id}`)) throw new Error('This draft is already on its way');
    this.sends.delete(`${slug}:${id}`);
    this.putDraft(slug, item.outbox, id, (d) => ({ ...d, state: 'discarded', resolvedAt: new Date(this.now).toISOString() }));
    addTimeline(this.deps.root, slug, `${dayOf(this.now)} [message]: discarded a draft to ${targetWords(draft.to)}`);
    await this.commit(slug, `${slug}: draft ${id} discarded`);
    this.refresh(slug);
  }

  private openDraft(item: InitiativeView, id: number): OutboxDraft {
    const draft = item.outbox.find((d) => d.id === id);
    if (!draft) throw new Error('That draft is gone');
    if (draft.state === 'sent' || draft.state === 'discarded') throw new Error(`That draft was already ${draft.state}`);
    return draft;
  }

  private putDraft(slug: string, outbox: readonly OutboxDraft[], id: number, change: (draft: OutboxDraft) => OutboxDraft): void {
    writeOutbox(this.deps.root, slug, outbox.map((d) => (d.id === id ? change(d) : d)));
  }

  /** The chat that does the work: the one asked for when the initiative has it, else the open one; never a chat a sentinel wakes afresh. */
  private workChannel(item: InitiativeView, asked?: string): string {
    const chat = asked !== undefined && item.chats.chats.some((c) => c.id === asked) ? asked : item.chats.active;
    return initiativeChatChannel(item.slug, chat === CHECK_IN_CHAT || chat === WATCH_CHAT ? FIRST_INITIATIVE_CHAT : chat);
  }

  /** A draft sent before the daemon stopped has no send left to wait for: say so, instead of sending forever. */
  private failLostSends(slug: string): void {
    const outbox = readFolder(this.deps.root, slug).outbox;
    if (!outbox.some((draft) => draft.state === 'approved' && !draft.sendError)) return;
    writeOutbox(this.deps.root, slug, outbox.map((draft) => (draft.state === 'approved' && !draft.sendError ? { ...draft, sendError: SEND_LOST } : draft)));
  }

  private recordSendError(send: Send, error: string): void {
    const folder = readFolder(this.deps.root, send.slug);
    this.putDraft(send.slug, folder.outbox, send.id, (draft) => ({ ...draft, sendError: error }));
    this.refresh(send.slug);
  }

  private sendHooks(slug: string, channel: string): Pick<InitiativeChatRun, 'vetTool' | 'preApproved' | 'onStep' | 'finish'> {
    type Attempt = { send: Send; tool: string; toolUseId?: string; input: ReturnType<typeof boundInput>['input']; preApproved: boolean };
    const attempts = new Map<string, Attempt>();
    const keyOf = (id: number): string => `${slug}:${id}`;
    return {
      vetTool: (tool, input, toolUseId) => {
        if (!isSendingTool(tool)) return undefined;
        const send = [...this.sends.values()].find((entry) => entry.slug === slug && entry.channel === channel && matchesDraft(entry.to, entry.text, tool, input));
        if (!send) return OUTBOX_DENIED;
        const matchingAttempt = [...attempts.values()].some((attempt) => toolUseId !== undefined
          ? attempt.toolUseId === toolUseId
          : attempt.tool === tool && matchesDraft(attempt.send.to, attempt.send.text, tool, input));
        if (matchingAttempt) return OUTBOX_DENIED;
        const key = keyOf(send.id);
        this.sends.delete(key);
        const folder = readFolder(this.deps.root, slug);
        const draft = folder.outbox.find((entry) => entry.id === send.id);
        if (draft?.state !== 'approved') return OUTBOX_DENIED;
        if (draft.reminderFor && !folder.watches.some((watch) => watch.id === draft.reminderFor && watch.state === 'watching' && watch.news.length === 0)) {
          this.recordSendError(send, 'The follow-up no longer needs a reminder.');
          return 'The follow-up no longer needs a reminder.';
        }

        this.sending.add(key);
        attempts.set(key, { send, tool, toolUseId, input: boundInput(input).input, preApproved: true });
        return undefined;
      },
      preApproved: (tool, input) => {
        const attempt = [...attempts.values()].find((entry) => entry.preApproved && entry.tool === tool && matchesDraft(entry.send.to, entry.send.text, tool, input));
        if (!attempt) return false;
        attempt.preApproved = false;
        return true;
      },
      onStep: (step) => {
        if (step.kind !== 'tool' || step.status === 'running') return;
        const match = [...attempts].find(([, attempt]) => attempt.tool === step.tool && (attempt.toolUseId !== undefined ? attempt.toolUseId === step.id : isDeepStrictEqual(attempt.input, step.input)));
        if (!match) return;
        const [key, { send }] = match;
        attempts.delete(key);
        this.sending.delete(key);
        if (step.status === 'error' || step.isError) {
          this.recordSendError(send, 'The send failed. Check the chat for details.');
          return;
        }
        if (step.output === undefined) {
          this.recordSendError(send, 'Delivery was not confirmed. Check the destination before retrying.');
          return;
        }
        const delivery = deliveryOf(send.to, step.output);
        if (delivery.error) this.recordSendError(send, delivery.error);
        else this.markSent(send, delivery);
      },
      finish: () => {
        for (const [key, attempt] of attempts) {
          this.sending.delete(key);
          this.recordSendError(attempt.send, 'Delivery was not confirmed. Check the destination before retrying.');
        }
        attempts.clear();
      },
    };
  }

  private markSent(send: Send, delivery: Delivery): void {
    const folder = readFolder(this.deps.root, send.slug);
    const draft = folder.outbox.find((d) => d.id === send.id);
    if (!draft || draft.state !== 'approved') return;
    const sent = { ...draft, state: 'sent' as const, resolvedAt: new Date(this.now).toISOString(), deliveryChannel: delivery.channel, deliveryThread: delivery.thread, source: delivery.source };
    this.putDraft(send.slug, folder.outbox, send.id, () => sent);
    if (draft.audience) this.keepUpdate(send.slug, draft, send.text);
    else {
      const recipient = folder.questions.find((question) => question.id === draft.question)?.waitingOn;
      addTimeline(this.deps.root, send.slug, `${dayOf(this.now)} [message]: sent ${SENT_WORDS[send.to.kind]} to ${targetWords(send.to)}${recipient ? ` (asked ${recipient.replace(/\s+/g, ' ')})` : ''}`);
    }
    this.watching.fromDraft(send.slug, sent);
    this.refresh(send.slug);
    void this.watching.sync(send.slug).catch(() => undefined);
  }

  async saveQuestion(slug: string, input: QuestionDraft): Promise<Question> {
    this.need(slug);
    const folder = readFolder(this.deps.root, slug);
    if (folder.trouble?.includes('questions.json:')) throw new Error(folder.trouble);
    const question = saveQuestionRecord(this.deps.root, folder, input, this.now);
    await this.commit(slug, `${slug}: question saved`);
    this.refresh(slug);
    await this.watching.sync(slug);
    return question;
  }

  async removeQuestion(slug: string, id: string): Promise<void> {
    this.need(slug);
    const folder = readFolder(this.deps.root, slug);
    if (folder.trouble?.includes('questions.json:')) throw new Error(folder.trouble);
    removeQuestionRecord(this.deps.root, folder, id, this.now);
    await this.commit(slug, `${slug}: question removed`);
    this.refresh(slug);
    await this.watching.sync(slug);
  }

  /** A chat settled a question (a reply it read, or the user's word): it closes with that answer, like Record an answer on the page. */
  private async answerQuestion(slug: string, input: Parameters<InitiativeQuestionTools['answer']>[0]): Promise<{ id: string; answered: boolean }> {
    const known = questionsOf(readFolder(this.deps.root, slug)).find((question) => question.id === input.id);
    if (!known) throw new Error('That question no longer exists');
    const answered = await this.saveQuestion(slug, { id: known.id, text: known.text, waitingOn: known.waitingOn, answer: { text: input.answer, source: input.source } });
    return { id: answered.id, answered: true };
  }

  private async trackQuestion(slug: string, input: Parameters<InitiativeQuestionTools['track']>[0]): Promise<{ id: string; answered: boolean }> {
    const folder = readFolder(this.deps.root, slug);
    const normalized = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();
    const known = questionsOf(folder).find((question) => input.id ? question.id === input.id : normalized(question.text) === normalized(input.text ?? ''));
    if (input.id && !known) throw new Error('That question no longer exists');
    if (known && folder.questions.includes(known)) return { id: known.id, answered: Boolean(known.answer) };
    const text = known?.text ?? input.text;
    if (!text) throw new Error('Provide the question or its ID');
    const tracked = await this.saveQuestion(slug, { id: known?.id, text, waitingOn: known?.waitingOn || input.waitingOn });
    return { id: tracked.id, answered: Boolean(tracked.answer) };
  }

  draftQuestion(slug: string, id: string): { readonly channel: string } {
    const item = this.need(slug);
    const question = readFolder(this.deps.root, slug).questions.find((entry) => entry.id === id);
    if (!question || question.answer || isRetired(question)) throw new Error('Choose an open question');
    if (item.outbox.some((draft) => draft.question === id && (draft.state === 'draft' || draft.state === 'approved'))) throw new Error('A draft for this question is already in the outbox');
    const channel = this.workChannel(item);
    const prompt = `Prepare a Slack message or Jira comment asking this initiative question. Use the initiative’s sources and directory to verify the destination. If the destination is unclear, ask me. Put one draft in outbox.json with "question": "${id}". Question: ${question.text}${question.waitingOn ? `
Ask: ${question.waitingOn}` : ''}`;
    if (this.deps.ask(prompt, channel) === undefined) throw new Error('The chat could not take it now');
    return { channel };
  }

  /** A stakeholder update the user sent, or a prep sheet they kept: its text in updates/, a record with the tickets as they stand (the next one's delta), and a timeline line. */
  private keepUpdate(slug: string, draft: OutboxDraft, text: string): void {
    const folder = readFolder(this.deps.root, slug);
    const audience = folder.config?.audiences.find((a) => a.id === draft.audience);
    const name = audience?.name ?? draft.audience ?? 'an audience';
    const day = dayOf(this.now);
    const prep = draft.to.kind === 'prep';
    if (draft.audience) {
      const file = `${UPDATES_DIR}/${day}-${draft.audience}-${draft.id}.md`;
      writeText(path.join(folder.folder, file), `# ${name}: ${DRAFT_KIND_WORDS[draft.to.kind]} · ${targetWords(draft.to)}\n\n${day}\n\n${text.trim()}\n`);
      const record = UpdateRecordSchema.parse({ audience: draft.audience, at: new Date(this.now).toISOString(), draft: draft.id, to: draft.to, file, tickets: ticketMarks(folder.tickets?.tickets ?? []) });
      writeUpdates(this.deps.root, slug, [...folder.updates, record]);
    }
    addTimeline(this.deps.root, slug, prep ? `${day} [update]: prep sheet for ${targetWords(draft.to)} ready for ${name}` : `${day} [update]: sent the ${name} update to ${targetWords(draft.to)}`);
  }

  /** Adds an audience for stakeholder updates, or edits one (by its id). */
  async saveAudience(slug: string, draft: AudienceDraft): Promise<{ readonly id: string }> {
    this.need(slug);
    const parsed = AudienceDraftSchema.parse(draft);
    const was = this.config(slug);
    const directory = readDirectory(this.deps.root);
    const stranger = parsed.people.find((person) => !directory.some((p) => p.slug === person));
    if (stranger) throw new Error(`${stranger} is not in the people directory`);
    const target = parsed.target;
    if (target.kind === 'prep' && !was.meetings.some((m) => m.match === target.meeting)) throw new Error('Follow that meeting first: Edit… › Meetings');
    const id = parsed.id ?? audienceIdOf(parsed.name, was.audiences.map((a) => a.id));
    const audience = { ...parsed, id };
    const audiences = was.audiences.some((a) => a.id === id) ? was.audiences.map((a) => (a.id === id ? audience : a)) : [...was.audiences, audience];
    writeConfig(this.deps.root, slug, InitiativeConfigSchema.parse({ ...was, audiences }));
    await this.commit(slug, `${slug}: audience ${id} saved`);
    this.refresh(slug);
    return { id };
  }

  async removeAudience(slug: string, id: string): Promise<void> {
    this.need(slug);
    const was = this.config(slug);
    if (!was.audiences.some((a) => a.id === id)) throw new Error('That audience is gone');
    writeConfig(this.deps.root, slug, InitiativeConfigSchema.parse({ ...was, audiences: was.audiences.filter((a) => a.id !== id) }));
    await this.commit(slug, `${slug}: audience ${id} removed`);
    this.refresh(slug);
  }

  /** The page's Draft Now: the Check-in chat drafts one audience's update into the outbox, from the facts Beluga works out. */
  draftUpdate(slug: string, id: string): { readonly channel: string } {
    const item = this.need(slug);
    const audience = (item.audiences ?? []).find((a) => a.id === id);
    if (!audience) throw new Error('That audience is gone');
    const channel = initiativeChatChannel(slug, CHECK_IN_CHAT);
    if (this.deps.ask(draftUpdatePrompt(item, audience, readDirectory(this.deps.root)), channel) === undefined) throw new Error('The chat could not take it now');
    return { channel };
  }

  /** A prep sheet is never sent: Done keeps it (with the user's edits) as that meeting's update. */
  async keepPrep(slug: string, id: number, text: string): Promise<void> {
    const item = this.need(slug);
    const draft = this.openDraft(item, id);
    if (draft.to.kind !== 'prep') throw new Error('Only a prep sheet is kept this way: send the others');
    const final = text.trim();
    if (!final) throw new Error('The prep sheet is empty');
    const edited = final !== draft.text.trim();
    this.putDraft(slug, item.outbox, id, (d) => ({ ...d, state: 'sent', resolvedAt: new Date(this.now).toISOString(), ...(edited ? { sentText: final } : {}) }));
    this.keepUpdate(slug, draft, final);
    await this.commit(slug, `${slug}: prep sheet ${id} kept`);
    this.refresh(slug);
  }

  /** The owner asks to keep looking for an answer (the page, or the chat on their word). */
  async addWatch(slug: string, draft: WatchDraft): Promise<Watch> {
    this.need(slug);
    return this.watching.add(slug, draft);
  }

  async stopWatch(slug: string, id: number): Promise<void> {
    this.need(slug);
    await this.watching.stop(slug, id);
  }

  lookNow(slug: string, id: number): { readonly channel: string } {
    this.need(slug);
    return this.watching.look(slug, id);
  }

  async readNews(slug: string, id?: number): Promise<void> {
    this.need(slug);
    await this.watching.markRead(slug, id);
  }

  /** The owner adds, changes or closes a risk on the page; the check-ins keep their edit. */
  async saveRisk(slug: string, draft: RiskDraft): Promise<{ readonly id: number }> {
    this.need(slug);
    const risk = this.risks.save(slug, draft, new Date(this.now).toISOString(), dayOf(this.now));
    await this.commit(slug, `${slug}: risk ${risk.id} ${draft.id === undefined ? 'added' : 'changed'}`);
    this.refresh(slug);
    return { id: risk.id };
  }

  /** Keeps a file a worktree made: copied into artifacts/, or, too big for the repo, noted where it is. */
  async reportArtifact(slug: string, report: ArtifactReport): Promise<string> {
    const item = this.need(slug);
    if (isSecretPath(report.file)) throw new Error('That file holds secrets: it stays where it is.');
    const bytes = this.fileSize(report.file);
    const id = item.artifacts.reduce((n, a) => Math.max(n, a.id), 0) + 1;
    const name = path.basename(report.file);
    const kept = bytes <= ARTIFACT_KEEP_MAX;
    const demo = item.discovery?.demo?.task;
    const about = report.about ?? (demo && report.ticket?.toUpperCase() === demo ? 'demo' : undefined);
    const artifact = ArtifactSchema.parse({
      id,
      title: report.title.trim(),
      why: report.why,
      ...(kept ? { file: keepArtifactFile(this.deps.root, slug, id, report.file) } : { path: report.file }),
      name,
      bytes,
      ticket: report.ticket,
      worktree: report.worktree,
      project: report.project,
      from: report.from,
      ...(about ? { about } : {}),
      createdAt: new Date(this.now).toISOString(),
    });
    writeArtifacts(this.deps.root, slug, [...item.artifacts, artifact]);
    addTimeline(this.deps.root, slug, `${dayOf(this.now)} [artifact]: artifact #${id} “${artifact.title}”${artifact.ticket ? ` from ${artifact.ticket}` : ''}`);
    await this.commit(slug, `${slug}: artifact ${id}`);
    this.refresh(slug);
    if (kept) return `Kept as artifact #${id} of ${item.name} (${artifact.file}). It shows on the initiative's page, and its next check-in reads it.`;
    return `${name} is ${formatBytes(bytes)}, too big for the initiatives repo: artifact #${id} of ${item.name} points at ${report.file}, so leave the file there.`;
  }

  private fileSize(file: string): number {
    try {
      const stat = statSync(file);
      if (stat.isFile()) return stat.size;
    } catch {
      throw new Error(`There is no file at ${file}`);
    }
    throw new Error(`${file} is a folder: send its files one by one, or a zip of it`);
  }

  readArtifact(slug: string, id: number): ArtifactRead {
    const item = this.need(slug);
    const artifact = item.artifacts.find((a) => a.id === id);
    if (!artifact) throw new Error('That artifact is gone');
    if (!artifact.file) return { kind: 'other', name: artifact.name, path: artifact.path ?? '' };
    const file = artifactPath(this.deps.root, slug, artifact.file);
    const kind = artifactKindOf(artifact.name);
    if (kind === 'text') return { kind, ...readMemoryFile(this.deps.root, slug, artifact.file), name: artifact.name };
    const mediaType = MEDIA_TYPES[artifact.name.toLowerCase().split('.').pop() ?? ''];
    if (kind === 'image' && mediaType && statSync(file).size <= IMAGE_READ_MAX) return { kind, name: artifact.name, mediaType, data: readFileSync(file).toString('base64') };
    return { kind: 'other', name: artifact.name, path: file };
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

  /** Every initiative chat outside `loaded`, from disk, with where it is: search reads them. */
  savedChats(loaded: ReadonlySet<string>): Array<{ readonly channel: string; readonly place: string; readonly items: readonly LogItem[] }> {
    const items = this.deps.store.getState().initiatives.items;
    return listSlugs(this.deps.root).flatMap((slug) => {
      const name = items.find((i) => i.slug === slug)?.name ?? slug;
      return this.chats.savedChats(slug, loaded).map((chat) => ({ ...chat, place: initiativeChatPlace(name, chat.channel, chat.items) }));
    });
  }

  /** `woken`: a sentinel sent the turn. The Check-in and Follow-ups chats then start a new session: all they need is in the folder. */
  chatRun(channel: string, from: string, opts: { readonly woken?: boolean } = {}): InitiativeChatRun | undefined {
    const of = initiativeChatOf(channel);
    if (!of || !this.known(of.slug)) return undefined;
    const place = this.chats.place(channel, from, { fresh: Boolean(opts.woken) && (of.chat === CHECK_IN_CHAT || of.chat === WATCH_CHAT) });
    if (!place) return undefined;
    const item = this.view(of.slug);
    const brief = readFolder(this.deps.root, of.slug).brief;
    return {
      place,
      brief: initiativeBrief(item, brief, this.repos(item), of.chat, readDirectory(this.deps.root), this.now) + this.success.brief(item, of.chat === CHECK_IN_CHAT),
      ...(of.chat !== WATCH_CHAT ? { questions: { track: (input) => this.trackQuestion(of.slug, input), answer: (input) => this.answerQuestion(of.slug, input) } } : {}),
      ...this.sendHooks(of.slug, channel),
    };
  }

  private refreshPeople(): void {
    if (this.stopped) return;
    const people = readDirectory(this.deps.root);
    this.deps.store.dispatch({ type: 'initiatives_people', people });
    this.enricher.refresh();
    void this.syncAvatars(people);
  }

  private async syncAvatars(people: readonly Person[]): Promise<void> {
    const before = JSON.stringify(this.avatars.shas(people));
    await this.avatars.sync(people).catch(() => false);
    const avatars = this.avatars.shas(people);
    if (!this.stopped && JSON.stringify(avatars) !== before) this.deps.store.dispatch({ type: 'initiatives_avatars', avatars });
  }

  /** Enrich People: your agent looks everyone (or these people) up; what it finds waits on the People page. */
  enrichPeople(only?: readonly string[]): void {
    this.enricher.start(only);
  }

  /** Takes what Enrich People found for someone (or one field of theirs) into their entry. */
  keepEnrichment(person: string, field?: EnrichField | null): Promise<void> {
    return this.enricher.keep(person, field ?? undefined);
  }

  dropEnrichment(person: string, field?: EnrichField | null): void {
    this.enricher.drop(person, field ?? undefined);
  }

  /** A directory person's kept picture, by its checksum. */
  personAvatar(sha: string): { readonly mime: string; readonly b64: string } | undefined {
    return this.avatars.read(sha);
  }

  /** Adds or edits a person in the directory (people/<slug>.json), shared by every initiative; a slug it doesn't have yet makes that entry. */
  async savePerson(draft: PersonDraft): Promise<{ readonly slug: string }> {
    const slug = writePerson(this.deps.root, draft);
    await this.commit(PEOPLE_DIR, `people: ${slug} saved`);
    this.refreshPeople();
    return { slug };
  }

  /** Takes a person out of the directory; only once no initiative names them. */
  async removePerson(person: string): Promise<void> {
    const on = listSlugs(this.deps.root).filter((slug) => readFolder(this.deps.root, slug).config?.people.some((p) => p.person === person));
    if (on.length) throw new Error(`Take them off ${on.map((slug) => this.view(slug).name).join(', ')} first`);
    removePersonFile(this.deps.root, person);
    await this.commit(PEOPLE_DIR, `people: ${person} removed`);
    this.refreshPeople();
  }

  /** Puts a directory person on an initiative with a role, changes it, or (role null) takes them off. */
  async setPerson(slug: string, person: string, role: string | null): Promise<InitiativeView> {
    const was = this.config(slug).people;
    if (role === null) return this.update(slug, { people: was.filter((p) => p.person !== person) });
    if (!readDirectory(this.deps.root).some((p) => p.slug === person)) throw new Error('That person is not in the directory');
    const entry = { person, ...(role.trim() ? { role: role.trim() } : {}) };
    const people = was.some((p) => p.person === person) ? was.map((p) => (p.person === person ? entry : p)) : [...was, entry];
    return this.update(slug, { people });
  }

  /** The one-time pass: the Check-in chat proposes people.md's people as one suggestion. */
  proposePeople(slug: string): { readonly channel: string } {
    this.need(slug);
    const channel = initiativeChatChannel(slug, CHECK_IN_CHAT);
    if (this.deps.ask(PEOPLE_PASS, channel) === undefined) throw new Error('The chat could not take it now');
    return { channel };
  }

  /** An approved people suggestion: each one into the directory and onto the initiative with their role. */
  private async keepPeople(slug: string, id: number): Promise<{ readonly channel?: string }> {
    const folder = readFolder(this.deps.root, slug);
    const suggestion = folder.suggestions.find((s) => s.id === id);
    const proposals = suggestion?.people ?? [];
    const kept = proposals.map((proposal) => ({ person: keepProposal(this.deps.root, proposal), role: proposal.role }));
    const was = this.config(slug).people;
    const people = [...was.filter((p) => !kept.some((k) => k.person === p.person)), ...kept.map((k) => ({ person: k.person, ...(k.role ? { role: k.role } : {}) }))];
    writeConfig(this.deps.root, slug, InitiativeConfigSchema.parse({ ...this.config(slug), people }));
    const outcome = `Added ${kept.length} ${kept.length === 1 ? 'person' : 'people'} to the directory and this initiative.`;
    writeSuggestions(this.deps.root, slug, folder.suggestions.map((s) => (s.id === id ? { ...s, outcome } : s)));
    addTimeline(this.deps.root, slug, `${dayOf(this.now)} [event]: ${outcome.charAt(0).toLowerCase()}${outcome.slice(1, -1)}`);
    await this.commit(PEOPLE_DIR, `people: from ${slug}`);
    await this.commit(slug, `${slug}: suggestion ${id} approved`);
    this.refreshPeople();
    this.refresh(slug);
    return {};
  }

  private onAction(action: Action): void {
    if (action.type !== 'agent_event' || !FINAL_EVENTS.has(action.event)) return;
    const of = initiativeChatOf(action.channel);
    if (!of || !this.known(of.slug)) return;
    if (action.text !== STEERED_IN) {
      for (const [key, send] of this.sends) {
        if (send.channel !== action.channel || send.requestId !== action.requestId) continue;
        this.sends.delete(key);
        this.recordSendError(send, 'The agent finished without sending this draft.');
      }
    }
    if (of.chat === WATCH_CHAT) this.watching.turnEnded(of.slug, action.event === 'done' && action.text !== STEERED_IN);
    if (action.event === 'done' && action.text !== STEERED_IN) captureQuestionAnswers(this.deps.root, readFolder(this.deps.root, of.slug));
    this.risks.settle(of.slug, new Date(this.now).toISOString(), dayOf(this.now));
    const message = of.chat === CHECK_IN_CHAT ? `${of.slug}: check-in ${dayOf(this.now)}` : of.chat === WATCH_CHAT ? `${of.slug}: follow-ups ${dayOf(this.now)}` : `${of.slug}: chat ${dayOf(this.now)}`;
    void this.keepSizing(of.slug)
      .catch(() => undefined)
      .then(() => this.commit(of.slug, message))
      .then(() => this.refresh(of.slug))
      .then(() => this.watching.sync(of.slug))
      .catch(() => undefined);
  }
}
