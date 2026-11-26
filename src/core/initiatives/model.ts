import { z } from 'zod';
import type { DecisionNotes } from './decisions.js';
import { type Audience, AudiencesSchema } from './audience.js';
import type { Enrichment } from './enrichment.js';
import type { Person, WaitingQuestion } from './people.js';
import type { UpdateRecord } from './updates.js';
import { QuestionIdSchema, QuestionSourceSchema, type Question } from './questions.js';
import type { Watch } from './watches.js';
import type { Risk } from './risks.js';
import { ARTIFACT_ABOUT, type Discovery } from './discovery-model.js';

export const INITIATIVE_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const INITIATIVE_CHAT_ID = /^[a-z0-9]{1,24}$/;
export const INITIATIVE_CHAT_PREFIX = 'initiative:';
export const FIRST_INITIATIVE_CHAT = 'main';
export const CHECK_IN_CHAT = 'checkin';
export const CHECK_IN_TITLE = 'Check-in';
export const WATCH_CHAT = 'watch';
export const WATCH_TITLE = 'Follow-ups';
export const DEFAULT_INITIATIVES_DIR = 'Documents/GitHub/initiatives';

export const EPIC_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,7}$/;

export const INITIATIVE_STATUSES = ['discovery', 'active', 'paused', 'shipped', 'archived'] as const;
export const InitiativeStatusSchema = z.enum(INITIATIVE_STATUSES);
export type InitiativeStatus = z.infer<typeof InitiativeStatusSchema>;

/** Someone on an initiative: a directory entry (`person`, its slug) with their role here. The old `{ name, role }` reads as the slug of its name. */
export const PersonSchema = z
  .object({
    person: z.string().regex(INITIATIVE_SLUG).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    role: z.string().max(200).optional(),
  })
  .refine((entry) => Boolean(entry.person || entry.name), { message: 'needs a person or a name' })
  .transform((entry): { person: string; name?: string; role?: string } => ({
    person: entry.person ?? slugOf(entry.name ?? ''),
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.role?.trim() ? { role: entry.role.trim() } : {}),
  }));
export type InitiativePerson = z.infer<typeof PersonSchema>;

export const GOAL_MAX = 12_000;

export const SlackRefSchema = z.object({
  ref: z.string().trim().min(1).max(500),
  label: z.string().trim().max(120).optional(),
});
export type SlackRef = z.infer<typeof SlackRefSchema>;

export const MeetingRefSchema = z.object({
  match: z.string().trim().min(1).max(500),
  label: z.string().trim().max(120).optional(),
});
export type MeetingRef = z.infer<typeof MeetingRefSchema>;

const slackRefs = z.array(SlackRefSchema).max(40);
const meetingRefs = z.array(MeetingRefSchema).max(40);

export const DOC_KINDS = ['confluence', 'gdoc', 'gsheet', 'gslides', 'link'] as const;
export const DocKindSchema = z.enum(DOC_KINDS);
export type DocKind = z.infer<typeof DocKindSchema>;

export const DOC_KIND_NAME: Readonly<Record<DocKind, string>> = { confluence: 'Confluence page', gdoc: 'Google Doc', gsheet: 'Google Sheet', gslides: 'Google Slides', link: 'Link' };

const GOOGLE_KINDS: ReadonlyArray<readonly [RegExp, DocKind]> = [
  [/^\/document\/(?:u\/\d+\/)?d\//, 'gdoc'],
  [/^\/spreadsheets\/(?:u\/\d+\/)?d\//, 'gsheet'],
  [/^\/presentation\/(?:u\/\d+\/)?d\//, 'gslides'],
];

const urlOf = (ref: string): URL | undefined => {
  try {
    return /^https?:\/\//i.test(ref.trim()) ? new URL(ref.trim()) : undefined;
  } catch {
    return undefined;
  }
};

export const confluencePageIdOf = (ref: string): string | undefined => {
  const url = urlOf(ref);
  if (!url) return undefined;
  return /\/pages\/(?:edit-v2\/)?(\d+)/.exec(url.pathname)?.[1] ?? /^\d+$/.exec(url.searchParams.get('pageId') ?? '')?.[0];
};

export const googleFileIdOf = (ref: string): string | undefined => {
  const url = urlOf(ref);
  if (!url || !/(^|\.)google\.com$/i.test(url.hostname)) return undefined;
  return /\/d\/([A-Za-z0-9_-]{10,})/.exec(url.pathname)?.[1];
};

export const docKindOf = (ref: string): DocKind => {
  const url = urlOf(ref);
  if (!url) return 'link';
  if (url.hostname.toLowerCase() === 'docs.google.com' && googleFileIdOf(ref)) return GOOGLE_KINDS.find(([path]) => path.test(url.pathname))?.[1] ?? 'link';
  if (/\/display\/[^/]+\/./.test(url.pathname)) return 'confluence';
  const confluencePath = /^\/wiki\//.test(url.pathname) || /\/spaces\//.test(url.pathname) || /\/pages\/viewpage\.action$/.test(url.pathname);
  return confluencePath && confluencePageIdOf(ref) ? 'confluence' : 'link';
};

const DocEntrySchema = z.object({
  ref: z.string().trim().min(1).max(500),
  label: z.string().trim().max(120).optional(),
  kind: DocKindSchema.optional(),
});

export const DocRefSchema = z.union([z.string().trim().min(1).max(500).transform((ref) => ({ ref })), DocEntrySchema]).transform(
  (entry): { ref: string; label?: string; kind: DocKind } => ({ ref: entry.ref, ...('label' in entry && entry.label ? { label: entry.label } : {}), kind: ('kind' in entry && entry.kind) || docKindOf(entry.ref) }),
);
export type DocRef = z.infer<typeof DocRefSchema>;

const docRefs = z.array(DocRefSchema).max(50);

export const InitiativeConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    goal: z.string().max(GOAL_MAX).default(''),
    status: InitiativeStatusSchema.default('active'),
    epics: z.array(z.string().regex(EPIC_KEY)).max(20).default([]),
    slack: slackRefs.optional(),
    slackChannels: z.array(z.string().max(500)).max(40).optional(),
    people: z.array(PersonSchema).max(100).default([]),
    meetings: meetingRefs.optional(),
    calendarMatch: z.string().max(500).optional(),
    docs: docRefs.default([]),
    repos: z.array(z.string().min(1).max(120)).max(30).default([]),
    audiences: AudiencesSchema.default([]),
    createdAt: z.string().max(40).optional(),
  })
  .transform(({ slackChannels, calendarMatch, slack, meetings, ...rest }) => ({
    ...rest,
    slack:
      slack ??
      (slackChannels ?? [])
        .map((ref) => ref.trim())
        .filter(Boolean)
        .map((ref): SlackRef => ({ ref })),
    meetings: meetings ?? (calendarMatch?.trim() ? [{ match: calendarMatch.trim() } satisfies MeetingRef] : []),
  }));
export type InitiativeConfig = z.infer<typeof InitiativeConfigSchema>;

export const InitiativeDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  goal: z.string().max(GOAL_MAX).optional(),
  epics: z.array(z.string().regex(EPIC_KEY)).max(20).optional(),
  slack: slackRefs.optional(),
  docs: docRefs.optional(),
  repos: z.array(z.string().min(1).max(120)).max(30).optional(),
  meetings: meetingRefs.optional(),
  status: z.enum(['discovery', 'active']).optional(),
});
export type InitiativeDraft = z.input<typeof InitiativeDraftSchema>;

export const InitiativePatchSchema = InitiativeDraftSchema.partial().extend({
  status: InitiativeStatusSchema.optional(),
  people: z.array(PersonSchema).max(100).optional(),
});
export type InitiativePatch = z.input<typeof InitiativePatchSchema>;

export const GoalRefineSchema = z.object({
  name: z.string().trim().max(120).default(''),
  goal: z.string().max(GOAL_MAX).default(''),
  epics: z.array(z.string().regex(EPIC_KEY)).max(20).default([]),
  docs: docRefs.optional(),
});
export type GoalRefine = z.infer<typeof GoalRefineSchema>;

const count = z.number().int().min(0).max(100_000);

export const EpicProgressSchema = z.object({
  key: z.string().max(40),
  title: z.string().max(300).optional(),
  total: count,
  done: count,
  inProgress: count.default(0),
  blocked: count.default(0),
  stale: count.default(0),
});
export type EpicProgress = z.infer<typeof EpicProgressSchema>;

export const EpicStatusSchema = z.object({
  at: z.string().max(40),
  total: count,
  done: count,
  inProgress: count.default(0),
  blocked: count.default(0),
  stale: count.default(0),
  epics: z.array(EpicProgressSchema).max(20).default([]),
});
export type EpicStatus = z.infer<typeof EpicStatusSchema>;

export const TICKET_CATEGORIES = ['todo', 'inProgress', 'done'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const PR_STATES = ['open', 'draft', 'merged', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

const squashed = (said: string): string => said.toLowerCase().replace(/[^a-z]/g, '');

export const ticketCategoryOf = (said: string): TicketCategory => {
  const word = squashed(said);
  if (word === 'done' || word === 'complete' || word === 'completed') return 'done';
  if (word === 'inprogress' || word === 'indeterminate') return 'inProgress';
  return 'todo';
};

export const prStateOf = (said: string): PrState => {
  const word = squashed(said);
  if (word === 'merged') return 'merged';
  if (word === 'draft') return 'draft';
  if (word === 'closed' || word === 'declined') return 'closed';
  return 'open';
};

const maybe = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || undefined);

export const TicketPrSchema = z.object({
  url: z.string().min(1).max(500),
  number: z
    .number()
    .int()
    .min(1)
    .nullish()
    .transform((value) => value ?? undefined),
  state: z.string().max(40).default('open').transform(prStateOf),
  repo: maybe(200),
  title: maybe(300),
});
export type TicketPr = z.infer<typeof TicketPrSchema>;

export const TICKET_LINK_TYPES = ['blocks', 'blockedBy'] as const;
export type TicketLinkType = (typeof TICKET_LINK_TYPES)[number];

/** A Jira "Blocks" link as either side says it; any other link type reads as none. */
export const ticketLinkTypeOf = (said: string): TicketLinkType | undefined => {
  const word = squashed(said);
  if (word === 'blockedby' || word === 'isblockedby') return 'blockedBy';
  return word === 'blocks' ? 'blocks' : undefined;
};

export const TicketLinkSchema = z.object({
  type: z.string().max(40).transform(ticketLinkTypeOf),
  key: z.string().min(1).max(40),
  summary: maybe(500),
  status: maybe(80),
  statusCategory: z.string().max(40).default('todo').transform(ticketCategoryOf),
  url: maybe(500),
});
export type TicketLink = Omit<z.infer<typeof TicketLinkSchema>, 'type'> & { readonly type: TicketLinkType };

const isTicketLink = (link: z.infer<typeof TicketLinkSchema>): link is TicketLink => link.type !== undefined;

export const TicketSchema = z.object({
  key: z.string().min(1).max(40),
  url: maybe(500),
  summary: z.string().max(500).default(''),
  status: z.string().max(80).default(''),
  statusCategory: z.string().max(40).default('todo').transform(ticketCategoryOf),
  assignee: maybe(120),
  updated: maybe(40),
  epic: maybe(40),
  parent: maybe(40),
  prs: z.array(TicketPrSchema).max(30).default([]),
  links: z
    .array(TicketLinkSchema)
    .max(50)
    .transform((links) => links.filter(isTicketLink))
    .optional(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const TicketEpicSchema = z.object({
  key: z.string().min(1).max(40),
  url: maybe(500),
  title: maybe(300),
});
export type TicketEpic = z.infer<typeof TicketEpicSchema>;

export const TicketsSchema = z.object({
  at: z.string().max(40),
  epics: z.array(TicketEpicSchema).max(20).default([]),
  tickets: z.array(TicketSchema).max(1000).default([]),
});
export type EpicTickets = z.infer<typeof TicketsSchema>;

export const TASK_PENDING = ['complete', 'reopen'] as const;
export type TaskPending = (typeof TASK_PENDING)[number];

/** A Google Task the agent keeps for this initiative (tasks.json); `pending` is a tick on its way to Google. */
export const InitiativeTaskSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().max(500).default(''),
  notes: maybe(2000),
  list: maybe(200),
  due: maybe(40),
  scheduled: maybe(40),
  done: z.boolean().default(false),
  pending: z
    .enum(TASK_PENDING)
    .nullish()
    .transform((value) => value ?? undefined),
  url: maybe(500),
});
export type InitiativeTask = z.infer<typeof InitiativeTaskSchema>;

export const TasksSchema = z.object({
  at: z.string().max(40),
  tasks: z.array(InitiativeTaskSchema).max(500).default([]),
});
export type InitiativeTasks = z.infer<typeof TasksSchema>;

export const CHECK_IN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const CheckInScheduleSchema = z.object({
  at: z.string().regex(CHECK_IN_TIME),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
});
export type CheckInSchedule = z.infer<typeof CheckInScheduleSchema>;

export const SUGGESTION_STATES = ['open', 'approved', 'dismissed'] as const;
/** An answered decision is approved; an agent writing "decided" means the same. */
export const SuggestionStateSchema = z.preprocess((state) => (state === 'decided' ? 'approved' : state), z.enum(SUGGESTION_STATES));
export type SuggestionState = z.infer<typeof SuggestionStateSchema>;

export const SuggestionProofSchema = z.object({
  label: z.string().min(1).max(200),
  url: z.string().max(2000).optional(),
});
export type SuggestionProof = z.infer<typeof SuggestionProofSchema>;

/** A directory entry the agent proposes from people.md (`person`: the entry it is, when one exists); approving writes it. */
export const PersonProposalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  person: maybe(40),
  role: maybe(200),
  cares: maybe(2000),
  slack: maybe(120),
  jira: maybe(120),
  notes: maybe(4000),
});
export type PersonProposal = z.infer<typeof PersonProposalSchema>;

export const SuggestionSchema = z.object({
  id: z.number().int().min(1),
  text: z.string().min(1).max(2000),
  why: z.string().max(2000).optional(),
  kind: z.preprocess((kind) => (kind === 'people' ? 'other' : kind), z.enum(['jira', 'slack', 'calendar', 'task', 'doc', 'decision', 'other'])).default('other'),
  /** Who it waits on (a person's slug or name): they owe the user. */
  waitingOn: z.string().trim().max(120).nullish(),
  /** Who waits on the user for it (a person's slug or name): the user owes them. */
  askedBy: z.string().trim().max(120).nullish(),
  /** People to add to the directory and this initiative, from the one-time people.md pass. */
  people: z.array(PersonProposalSchema).max(100).optional(),
  /** A decision's answers to pick from; Other… lets the user write their own. */
  options: z.array(z.string().min(1).max(200)).max(6).optional(),
  /** What the user decided, once they did. */
  answer: z.string().max(2000).optional(),
  state: SuggestionStateSchema.default('open'),
  createdAt: z.string().max(40).optional(),
  resolvedAt: z.string().max(40).optional(),
  clarifiedAt: z.string().max(40).optional(),
  outcome: z.string().max(2000).optional(),
  proof: z.array(SuggestionProofSchema).max(20).optional(),
  /** What it is about: the tickets, threads and docs behind it. */
  sources: z.array(SuggestionProofSchema).max(20).optional(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const SuggestionsSchema = z.array(SuggestionSchema).max(500);

/** What a worktree sent the initiative (artifacts.json): kept in `artifacts/` (`file`), or, too big for the repo, where it is on this computer (`path`). */
export const ArtifactSchema = z.object({
  id: z.number().int().min(1),
  title: z.string().min(1).max(200),
  why: maybe(1000),
  file: maybe(400),
  path: maybe(4096),
  name: z.string().min(1).max(255),
  bytes: z.number().int().min(0).default(0),
  ticket: maybe(40),
  worktree: maybe(200),
  project: maybe(200),
  from: maybe(120),
  about: z.enum(ARTIFACT_ABOUT).optional().catch(undefined),
  createdAt: z.string().max(40),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactsSchema = z.array(ArtifactSchema).max(1000);

/** Files the repo keeps: GitHub warns at 50 MB and refuses a file over 100 MB. */
export const ARTIFACT_KEEP_MAX = 50 * 1024 * 1024;

export const ARTIFACT_KINDS = ['text', 'image', 'other'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'txt', 'log', 'json', 'xml', 'csv', 'tsv', 'yaml', 'yml', 'html', 'htm', 'diff', 'patch', 'sql', 'ts', 'tsx', 'js', 'py', 'sh']);
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

/** A graph kept as its `beluga-graph` JSON (`initiatives.keepGraph`, or a worktree's report): the page draws it live. */
export const GRAPH_ARTIFACT_EXT = '.graph.json';
export const isGraphArtifact = (name: string): boolean => name.toLowerCase().endsWith(GRAPH_ARTIFACT_EXT);

export const artifactKindOf = (name: string): ArtifactKind => {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'other';
};

/** An artifact as the page shows it: its text, its picture, or where it is (a file the page can't draw). */
export type ArtifactRead =
  | { readonly kind: 'text'; readonly name: string; readonly text: string; readonly cut: boolean }
  | { readonly kind: 'image'; readonly name: string; readonly mediaType: string; readonly data: string }
  | { readonly kind: 'other'; readonly name: string; readonly path: string };

/** Newest first. */
export const sortedArtifacts = (artifacts: readonly Artifact[]): Artifact[] => [...artifacts].sort((a, b) => b.id - a.id);

/** The initiative a ticket belongs to: one of its epics, a ticket read under them, or a sub-task of one. Active ones win. */
export const initiativeOfTicket = <T extends Pick<InitiativeView, 'slug' | 'status' | 'epics' | 'tickets'>>(items: readonly T[], key: string): T | undefined => {
  const wanted = key.toUpperCase();
  const holds = (item: T): boolean => item.epics.some((e) => e.toUpperCase() === wanted) || Boolean(item.tickets?.tickets.some((t) => t.key.toUpperCase() === wanted));
  const open = items.filter((item) => item.status !== 'archived');
  return open.find((item) => item.status === 'active' && holds(item)) ?? open.find(holds);
};

const TICKET_KEY = /\b([A-Z][A-Z0-9_]+-\d+)\b/;

/** A ticket key in a branch or worktree name (RUN-52/core-engine, run-52-fix-nav). */
export const ticketKeyIn = (text: string | undefined): string | undefined => TICKET_KEY.exec((text ?? '').toUpperCase())?.[1];

export const OUTBOX_STATES = ['draft', 'approved', 'sent', 'discarded'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

const PAGE_ID = /^\d{1,20}$/;

/** Where a draft goes: a Slack channel, DM or thread (by its ids), a comment on a Jira ticket, one section of a Confluence page (by page id and heading), a file of the folder as a whole Confluence page (new in a space, or over a page), or a prep sheet for a meeting, which is never sent. */
export const OutboxTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slack'), channel: z.string().min(1).max(80), thread: z.string().max(40).optional(), label: z.string().max(200).optional() }),
  z.object({ kind: z.literal('jira'), issue: z.string().regex(JIRA_KEY), label: z.string().max(200).optional() }),
  z.object({ kind: z.literal('confluence'), page: z.string().regex(/^\d{1,20}$/), section: z.string().trim().min(1).max(200), label: z.string().max(200).optional() }),
  z.object({ kind: z.literal('prep'), meeting: z.string().trim().min(1).max(500), label: z.string().max(200).optional() }),
  z.object({ kind: z.literal('confluence-page'), file: z.string().min(1).max(400), title: z.string().trim().min(1).max(255), space: z.string().max(80).optional(), page: z.string().regex(PAGE_ID).optional(), parent: z.string().regex(PAGE_ID).optional(), label: z.string().max(200).optional() }),
]);
export type OutboxTarget = z.infer<typeof OutboxTargetSchema>;

/** A Slack message or Jira comment; a Confluence section or a prep sheet has room for the detailed tone. */
export const MESSAGE_MAX = 5000;
export const PAGE_MAX = 20_000;

export const textMaxOf = (to: Pick<OutboxTarget, 'kind'>): number => (to.kind === 'slack' || to.kind === 'jira' ? MESSAGE_MAX : PAGE_MAX);

/** What it is, in a few words: "Slack message", "Confluence update". */
export const DRAFT_KIND_WORDS: Readonly<Record<OutboxTarget['kind'], string>> = { slack: 'Slack message', jira: 'Jira comment', confluence: 'Confluence update', 'confluence-page': 'Confluence page', prep: 'Prep sheet' };

/**
 * A message the agent prepared and the user sends (or discards) from the chat (outbox.json).
 * `text` stays as the agent wrote it; `sentText` is what the user sent when they edited it.
 */
export const OutboxDraftSchema = z.object({
  id: z.number().int().min(1),
  to: OutboxTargetSchema,
  text: z.string().min(1).max(PAGE_MAX),
  why: z.string().max(2000).optional(),
  suggestion: z.number().int().min(1).optional(),
  question: QuestionIdSchema.optional(),
  reminderFor: z.number().int().positive().optional(),
  /** false: an announcement, a recorded decision or an FYI, so sending it starts no follow-up. */
  expectsReply: z.boolean().optional(),
  source: QuestionSourceSchema.optional(),
  deliveryChannel: z.string().max(80).optional(),
  deliveryThread: z.string().max(40).optional(),
  sendError: z.string().max(300).optional(),
  /** The audience (initiative.json's `audiences`) this is the stakeholder update for. */
  audience: z.string().max(40).optional(),
  state: z.enum(OUTBOX_STATES).default('draft'),
  sentText: z.string().max(PAGE_MAX).optional(),
  createdAt: z.string().max(40).optional(),
  resolvedAt: z.string().max(40).optional(),
});
export type OutboxDraft = z.infer<typeof OutboxDraftSchema>;

export const OutboxSchema = z.array(OutboxDraftSchema).max(500);

export type InitiativeChat = {
  readonly id: string;
  readonly channel: string;
  readonly createdAt: number;
  /** Its own model, picked in the chat (none: Settings' initiative model or your default). */
  readonly model?: string;
};

export type InitiativeChats = {
  readonly chats: readonly InitiativeChat[];
  readonly active: string;
};

export type InitiativeView = {
  readonly slug: string;
  readonly folder: string;
  readonly name: string;
  readonly goal: string;
  readonly status: InitiativeStatus;
  readonly epics: readonly string[];
  readonly slack: readonly SlackRef[];
  readonly docs: readonly DocRef[];
  readonly repos: readonly string[];
  readonly meetings: readonly MeetingRef[];
  readonly people: readonly InitiativePerson[];
  /** Who gets a stakeholder update, how and when (initiative.json). */
  readonly audiences?: readonly Audience[];
  /** The updates sent (or prep sheets kept), oldest first (updates.json). */
  readonly updates?: readonly UpdateRecord[];
  readonly progress?: EpicStatus;
  readonly tickets?: EpicTickets;
  readonly tasks?: InitiativeTasks;
  readonly suggestions: readonly Suggestion[];
  readonly outbox: readonly OutboxDraft[];
  readonly watches?: readonly Watch[];
  readonly artifacts: readonly Artifact[];
  readonly risks?: readonly Risk[];
  readonly discovery?: Discovery;
  readonly timeline: readonly TimelineEntry[];
  readonly decisions?: DecisionNotes;
  /** decisions.md's open questions marked "(waiting on: …)". */
  readonly questions?: readonly Question[];
  readonly waitingQuestions?: readonly WaitingQuestion[];
  readonly files: readonly string[];
  readonly checkIn?: string;
  readonly success?: import('./success.js').SuccessFile;
  readonly chats: InitiativeChats;
  readonly trouble?: string;
};

export type BackupTrouble = {
  readonly since: number;
  readonly error: string;
};

export type InitiativesState = {
  readonly enabled: boolean;
  readonly root: string;
  readonly items: readonly InitiativeView[];
  /** The people directory (people/<slug>.json at the repo's root), shared by every initiative. */
  readonly people?: readonly Person[];
  /** Enrich People: running, or what it found for the owner to take or dismiss (enricher.ts). */
  readonly enrichment?: Enrichment;
  /** Each directory person's kept picture by checksum (people-avatars.ts), fetched with initiatives.personAvatar. */
  readonly avatars?: Readonly<Record<string, string>>;
  readonly backup?: BackupTrouble;
};

export type InitiativesSlice = {
  readonly initiatives: InitiativesState;
};

export const NO_INITIATIVES: InitiativesState = { enabled: false, root: '', items: [] };

export const initialInitiatives: InitiativesSlice = { initiatives: NO_INITIATIVES };

export type InitiativesAction =
  | { type: 'initiatives_init'; state: InitiativesState }
  | { type: 'initiative_put'; item: InitiativeView }
  | { type: 'initiative_remove'; slug: string }
  | { type: 'initiatives_backup'; backup?: BackupTrouble }
  | { type: 'initiatives_people'; people: readonly Person[] }
  | { type: 'initiatives_enrichment'; enrichment: Enrichment }
  | { type: 'initiatives_avatars'; avatars: Readonly<Record<string, string>> }
  | { type: 'initiatives_off' };

export const reduceInitiatives = (state: InitiativesSlice, action: InitiativesAction): InitiativesSlice => {
  const current = state.initiatives;
  if (action.type === 'initiatives_init') return { initiatives: { ...action.state, ...(current.backup ? { backup: current.backup } : {}) } };
  if (action.type === 'initiatives_backup') {
    const { backup: _was, ...rest } = current;
    return { initiatives: action.backup ? { ...rest, backup: action.backup } : rest };
  }
  if (action.type === 'initiatives_off') return { initiatives: NO_INITIATIVES };
  if (action.type === 'initiatives_people') return { initiatives: { ...current, people: action.people } };
  if (action.type === 'initiatives_enrichment') return { initiatives: { ...current, enrichment: action.enrichment } };
  if (action.type === 'initiatives_avatars') return { initiatives: { ...current, avatars: action.avatars } };
  if (action.type === 'initiative_remove') return { initiatives: { ...current, items: current.items.filter((i) => i.slug !== action.slug) } };
  const at = current.items.findIndex((i) => i.slug === action.item.slug);
  const items = at >= 0 ? current.items.map((i, n) => (n === at ? action.item : i)) : [...current.items, action.item];
  return { initiatives: { ...current, items } };
};

export const initiativeChatChannel = (slug: string, chat: string): string => `${INITIATIVE_CHAT_PREFIX}${slug}:${chat}`;

const CHANNEL = /^initiative:([a-z0-9][a-z0-9-]{0,39}):([a-z0-9]{1,24})$/;

export const initiativeChatOf = (channel: string | undefined): { readonly slug: string; readonly chat: string } | undefined => {
  const match = channel ? CHANNEL.exec(channel) : null;
  if (!match) return undefined;
  return { slug: match[1]!, chat: match[2]! };
};

export const isInitiativeChat = (channel: string | undefined): boolean => initiativeChatOf(channel) !== undefined;

export const activeInitiativeChat = (item: Pick<InitiativeView, 'slug' | 'chats'>): string => {
  const chat = item.chats.chats.find((c) => c.id === item.chats.active) ?? item.chats.chats[0];
  return chat?.channel ?? initiativeChatChannel(item.slug, FIRST_INITIATIVE_CHAT);
};

type TitleLog = ReadonlyArray<{ readonly channel: string; readonly type: string; readonly byAgent?: boolean; readonly text?: string }>;

export const initiativeChatTitle = (channel: string, log: TitleLog, max = 40): string => {
  if (initiativeChatOf(channel)?.chat === CHECK_IN_CHAT) return CHECK_IN_TITLE;
  if (initiativeChatOf(channel)?.chat === WATCH_CHAT) return WATCH_TITLE;
  const first = log.find((l) => l.channel === channel && l.type === 'chat' && !l.byAgent && l.text?.trim());
  const line = (first?.text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!line) return 'New chat';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

export const initiativeOf = (state: InitiativesState, slug: string): InitiativeView | undefined => state.items.find((i) => i.slug === slug);

export const initiativeChatName = (state: InitiativesState, channel: string): string | undefined => {
  const of = initiativeChatOf(channel);
  return of ? initiativeOf(state, of.slug)?.name : undefined;
};

export const slugOf = (name: string): string => {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || 'initiative';
};

export const uniqueSlug = (name: string, taken: ReadonlySet<string>): string => {
  const base = slugOf(name);
  if (!taken.has(base)) return base;
  const at = (n: number): string => `${base.slice(0, 40 - String(n).length - 1).replace(/-+$/g, '')}-${n}`;
  let n = 2;
  while (taken.has(at(n))) n += 1;
  return at(n);
};

const bullet = (line: string): string | undefined => {
  const match = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
  return match?.[1];
};

export const TIMELINE_KINDS = ['check-in', 'decision', 'message', 'ticket', 'said', 'doc', 'meeting', 'artifact', 'created', 'update', 'follow-up', 'risk', 'event'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** One bullet of timeline.md: "- 2026-11-25 [check-in]: …", the kind and even the day optional. */
export type TimelineEntry = {
  readonly day: string;
  readonly kind: TimelineKind;
  readonly text: string;
};

const TIMELINE_LINE = /^(?:(\d{4}-\d{2}-\d{2})\s*(?:\[([a-z-]+)\])?\s*:\s*)?(.+)$/;

const isTimelineKind = (kind: string | undefined): kind is TimelineKind => (TIMELINE_KINDS as readonly string[]).includes(kind ?? '');

export const timelineEntryOf = (line: string): TimelineEntry => {
  const match = TIMELINE_LINE.exec(line.trim());
  const kind = match?.[2];
  return { day: match?.[1] ?? '', kind: isTimelineKind(kind) ? kind : 'event', text: match?.[3] ?? line };
};

export const timelineOf = (markdown: string, max = 500): TimelineEntry[] =>
  markdown
    .split('\n')
    .map(bullet)
    .filter((b): b is string => Boolean(b))
    .slice(0, max)
    .map(timelineEntryOf);

export const openSuggestions = (item: Pick<InitiativeView, 'suggestions'>): Suggestion[] => item.suggestions.filter((s) => s.state === 'open');

export const progressShare = (progress: EpicStatus | undefined): number | undefined => {
  if (!progress || progress.total <= 0) return undefined;
  return Math.min(1, Math.max(0, progress.done / progress.total));
};

export const suggestionMessage = (suggestion: Pick<Suggestion, 'id' | 'text'>): string => `Do suggestion ${suggestion.id}: ${suggestion.text}`;

export const clarifyMessage = (suggestion: Pick<Suggestion, 'id' | 'text' | 'why'>): string =>
  `Clarify suggestion ${suggestion.id}: ${suggestion.text}${suggestion.why ? `\nWhy: ${suggestion.why}` : ''}`;

/** Drafts still waiting for the user, and those on their way out. */
export const pendingDrafts = (item: Pick<InitiativeView, 'outbox'>): OutboxDraft[] => item.outbox.filter((d) => d.state === 'draft' || d.state === 'approved');

/** A tool that posts a draft (its name's last part, whatever the MCP server is called) and the input field holding the text. */
type OutboxTool = { readonly name: string; readonly kind: OutboxTarget['kind']; readonly field: string };

const OUTBOX_TOOL_LIST: readonly OutboxTool[] = [
  { name: 'slack_send_message', kind: 'slack', field: 'message' },
  { name: 'conversations_add_message', kind: 'slack', field: 'text' },
  { name: 'jira_add_comment', kind: 'jira', field: 'body' },
  { name: 'confluence_update_page_section', kind: 'confluence', field: 'new_content' },
  { name: 'confluence_create_page', kind: 'confluence-page', field: 'content' },
  { name: 'confluence_update_page', kind: 'confluence-page', field: 'content' },
];

/** A draft that goes out (a prep sheet never does). */
export type SentTarget = Exclude<OutboxTarget, { kind: 'prep' }>;

export const isSentTarget = (to: OutboxTarget): to is SentTarget => to.kind !== 'prep';

/** The tool the chat is first told to post a draft with. */
export const OUTBOX_TOOLS: Readonly<Record<SentTarget['kind'], string>> = { slack: 'slack_send_message', jira: 'jira_add_comment', confluence: 'confluence_update_page_section', 'confluence-page': 'confluence_create_page' };

const nameIs = (toolName: string, name: string): boolean => toolName === name || toolName.endsWith(`__${name}`) || (name === 'slack_send_message' && toolName === 'mcp__codex_apps__slack_slack_send_message');

/** Tools that send a message outward, which an initiative's chat only uses for a draft the user sent. */
const SENDING_TOOLS: readonly string[] = [...OUTBOX_TOOL_LIST.map((t) => t.name), 'slack_schedule_message'];

export const isSendingTool = (toolName: string): boolean => SENDING_TOOLS.some((t) => nameIs(toolName, t));

const same = (a: unknown, b: string | undefined): boolean => (typeof a === 'string' ? a.trim() : '') === (b ?? '').trim();

/** Whether this tool call posts exactly that text to exactly that place. */
export const matchesDraft = (to: OutboxTarget, text: string, toolName: string, input: Record<string, unknown>): boolean => {
  const tool = OUTBOX_TOOL_LIST.find((t) => t.kind === to.kind && nameIs(toolName, t.name));
  if (!tool || input.blocks !== undefined) return false;
  return whereMatches(to, toolName, input) && same(input[tool.field], text);
};

const whereMatches = (to: OutboxTarget, toolName: string, input: Record<string, unknown>): boolean => {
  if (to.kind === 'slack') return same(input.channel_id, to.channel) && same(input.thread_ts, to.thread) && input.reply_broadcast !== true && input.draft_id === undefined;
  if (to.kind === 'jira') return same(input.issue_key, to.issue);
  if (to.kind === 'confluence') return same(input.page_id, to.page) && input.heading_text === to.section && (input.content_format === undefined || input.content_format === 'markdown');
  if (to.kind === 'confluence-page') return pageMatches(to, toolName, input);
  return false;
};

const pageMatches = (to: Extract<OutboxTarget, { kind: 'confluence-page' }>, toolName: string, input: Record<string, unknown>): boolean => {
  if (!same(input.title, to.title)) return false;
  if (to.page) return nameIs(toolName, 'confluence_update_page') && same(input.page_id, to.page);
  return nameIs(toolName, 'confluence_create_page') && same(input.space_key, to.space) && same(input.parent_id, to.parent);
};

export const targetWords = (to: OutboxTarget): string => {
  if (to.kind === 'confluence-page') return to.label ?? `“${to.title}”${to.space ? ` in ${to.space}` : ''}`;
  if (to.kind === 'jira') return to.label ? `${to.issue}: ${to.label}` : `a comment on ${to.issue}`;
  if (to.kind === 'confluence') return `${to.label ?? `Confluence page ${to.page}`} › ${to.section}`;
  if (to.kind === 'prep') return to.label ?? to.meeting;
  const where = to.label ?? to.channel;
  return to.thread ? `${where} (in a thread)` : where;
};

/** What the chat is told when the user sends a draft: the call to make, word for word. */
export const sendDraftMessage = (draft: Pick<OutboxDraft, 'id'> & { readonly to: SentTarget }, text: string): string => {
  const to = draft.to;
  if (to.kind === 'confluence-page') return confluencePageMessage(draft.id, to);
  if (to.kind === 'confluence')
    return `Send draft ${draft.id} from the outbox now: ${OUTBOX_TOOLS.confluence} with page_id ${to.page}, heading_text exactly "${to.section}", content_format markdown, and new_content exactly as below (the section's body, without its heading), nothing added or changed.\n\n${text}`;
  const call =
    to.kind === 'slack'
      ? `${OUTBOX_TOOLS.slack} (or conversations_add_message, with the message as text and no blocks) with channel_id ${to.channel}${to.thread ? ` and thread_ts ${to.thread}` : ''}`
      : `${OUTBOX_TOOLS.jira} with issue_key ${to.issue}`;
  return `Send draft ${draft.id} from the outbox now: ${call}, and the ${to.kind === 'slack' ? 'message' : 'body'} exactly as below, nothing added or changed.\n\n${text}`;
};

const confluencePageMessage = (id: number, to: Extract<OutboxTarget, { kind: 'confluence-page' }>): string => {
  const call = to.page
    ? `confluence_update_page with page_id ${to.page}`
    : `confluence_create_page with space_key ${to.space ?? '(ask me which space first)'}${to.parent ? ` and parent_id ${to.parent}` : ''}`;
  return `Send draft ${id} from the outbox now: ${call}, title “${to.title}”, content_format markdown, and as content exactly the text of ${to.file} as it is now, nothing added or changed.`;
};

/** A suggestion the user answers instead of approving: a decision kind, or one with answers to pick. */
export const isDecision = (suggestion: Pick<Suggestion, 'kind' | 'options'>): boolean => suggestion.kind === 'decision' || Boolean(suggestion.options?.length);

export const decisionMessage = (suggestion: Pick<Suggestion, 'id' | 'text'>, answer: string): string =>
  `Decided suggestion ${suggestion.id}: ${suggestion.text}\nAnswer: ${answer}`;

export const lastCheckInAt = (item: Pick<InitiativeView, 'progress'>): number | undefined => {
  const at = item.progress ? Date.parse(item.progress.at) : NaN;
  return Number.isFinite(at) ? at : undefined;
};

export const linkOf = (ref: string): string | undefined => (/^https?:\/\/\S+$/i.test(ref.trim()) ? ref.trim() : undefined);

export type SlackKind = 'channel' | 'thread' | 'conversation';

export const slackKindOf = (ref: string): SlackKind => {
  const link = linkOf(ref);
  if (!link) return 'channel';
  return /\/p\d{10,}|[?&]thread_ts=/.test(link) ? 'thread' : 'conversation';
};

export const meetingKindOf = (match: string): 'event' | 'title' => (linkOf(match) ? 'event' : 'title');

const CATEGORY_RANK: Readonly<Record<TicketCategory, number>> = { inProgress: 0, todo: 1, done: 2 };

const updatedAt = (ticket: Pick<Ticket, 'updated'>): number => {
  const at = ticket.updated ? Date.parse(ticket.updated) : NaN;
  return Number.isFinite(at) ? at : 0;
};

export const sortedTickets = (tickets: readonly Ticket[]): Ticket[] =>
  [...tickets].sort((a, b) => CATEGORY_RANK[a.statusCategory] - CATEGORY_RANK[b.statusCategory] || updatedAt(b) - updatedAt(a) || a.key.localeCompare(b.key, undefined, { numeric: true }));

export type TicketGroup = {
  readonly epic?: string;
  readonly tickets: readonly Ticket[];
};

/** Whether a ticket is a sub-task of another ticket that was read with it. */
export const isSubTask = (ticket: Pick<Ticket, 'parent'>, tickets: readonly Pick<Ticket, 'key'>[]): boolean => Boolean(ticket.parent && tickets.some((t) => t.key === ticket.parent));

/** A ticket's sub-tasks, open ones first. */
export const subTasksOf = (key: string, tickets: readonly Ticket[]): Ticket[] => sortedTickets(tickets.filter((t) => t.parent === key));

/** The tickets under the epics, without the sub-tasks, which show under their parent ticket. */
export const ticketGroups = (tickets: readonly Ticket[], epics: readonly string[]): TicketGroup[] => {
  const sorted = sortedTickets(tickets.filter((t) => !isSubTask(t, tickets)));
  if (epics.length < 2) return sorted.length ? [{ tickets: sorted }] : [];
  const known = epics.map((epic): TicketGroup => ({ epic, tickets: sorted.filter((t) => t.epic === epic) }));
  const rest = sorted.filter((t) => !t.epic || !epics.includes(t.epic));
  return [...known, ...(rest.length ? [{ tickets: rest }] : [])].filter((g) => g.tickets.length);
};

export const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((key) => b.includes(key));

const BROWSE = /\/browse\/[A-Z][A-Z0-9_]+-\d+.*$/;

/** An epic's Jira link: the one the agent read, or a ticket's link with the epic's key in its place. */
export const epicUrlOf = (key: string, tickets: Pick<EpicTickets, 'epics' | 'tickets'> | undefined): string | undefined => {
  const known = tickets?.epics.find((e) => e.key === key)?.url;
  if (known && linkOf(known)) return linkOf(known);
  const sample = [...(tickets?.tickets ?? []), ...(tickets?.epics ?? [])].map((t) => t.url).find((url): url is string => Boolean(url && linkOf(url) && BROWSE.test(url)));
  return sample ? sample.replace(BROWSE, `/browse/${key}`) : undefined;
};

/** Any ticket's Jira link: the one the agent read, or one built like the epic's. */
export const ticketUrlOf = (key: string, tickets: Pick<EpicTickets, 'epics' | 'tickets'> | undefined): string | undefined => {
  const known = tickets?.tickets.find((t) => t.key === key)?.url;
  return (known && linkOf(known)) || epicUrlOf(key, tickets);
};

export const epicTitleOf =(key: string, item: Pick<InitiativeView, 'tickets' | 'progress'>): string | undefined =>
  item.tickets?.epics.find((e) => e.key === key)?.title ?? item.progress?.epics.find((e) => e.key === key)?.title;

const timeOf = (iso: string | undefined): number => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
};

export type TaskGroups = {
  readonly scheduled: readonly InitiativeTask[];
  readonly unscheduled: readonly InitiativeTask[];
  readonly done: readonly InitiativeTask[];
};

/** Open tasks with a calendar slot (soonest first), open ones without (by due date, then title), and done ones. */
export const taskGroups = (tasks: readonly InitiativeTask[]): TaskGroups => {
  const open = tasks.filter((t) => !t.done);
  const byTitle = (a: InitiativeTask, b: InitiativeTask): number => a.title.localeCompare(b.title);
  return {
    scheduled: open.filter((t) => t.scheduled).sort((a, b) => timeOf(a.scheduled) - timeOf(b.scheduled) || byTitle(a, b)),
    unscheduled: open.filter((t) => !t.scheduled).sort((a, b) => timeOf(a.due) - timeOf(b.due) || byTitle(a, b)),
    done: tasks.filter((t) => t.done).sort(byTitle),
  };
};

/** What the chat is told when the user ticks a task on the page. */
export const taskMessage = (task: Pick<InitiativeTask, 'id' | 'title'>, done: boolean): string =>
  `${done ? 'Complete' : 'Reopen'} task ${task.id}: ${task.title}`;
