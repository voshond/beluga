import { z } from 'zod';

export const INITIATIVE_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const INITIATIVE_CHAT_ID = /^[a-z0-9]{1,24}$/;
export const INITIATIVE_CHAT_PREFIX = 'initiative:';
export const FIRST_INITIATIVE_CHAT = 'main';
export const CHECK_IN_CHAT = 'checkin';
export const CHECK_IN_TITLE = 'Check-in';
export const DEFAULT_INITIATIVES_DIR = 'Documents/GitHub/initiatives';

export const EPIC_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,7}$/;

export const INITIATIVE_STATUSES = ['active', 'paused', 'shipped', 'archived'] as const;
export const InitiativeStatusSchema = z.enum(INITIATIVE_STATUSES);
export type InitiativeStatus = z.infer<typeof InitiativeStatusSchema>;

export const PersonSchema = z.object({
  name: z.string().min(1).max(120),
  role: z.string().max(200).optional(),
});
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
    docs: z.array(z.string().min(1).max(500)).max(50).default([]),
    repos: z.array(z.string().min(1).max(120)).max(30).default([]),
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
  docs: z.array(z.string().min(1).max(500)).max(50).optional(),
  repos: z.array(z.string().min(1).max(120)).max(30).optional(),
  meetings: meetingRefs.optional(),
});
export type InitiativeDraft = z.infer<typeof InitiativeDraftSchema>;

export const InitiativePatchSchema = InitiativeDraftSchema.partial().extend({
  status: InitiativeStatusSchema.optional(),
  people: z.array(PersonSchema).max(100).optional(),
});
export type InitiativePatch = z.infer<typeof InitiativePatchSchema>;

export const GoalRefineSchema = z.object({
  name: z.string().trim().max(120).default(''),
  goal: z.string().max(GOAL_MAX).default(''),
  epics: z.array(z.string().regex(EPIC_KEY)).max(20).default([]),
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

export const TicketSchema = z.object({
  key: z.string().min(1).max(40),
  url: maybe(500),
  summary: z.string().max(500).default(''),
  status: z.string().max(80).default(''),
  statusCategory: z.string().max(40).default('todo').transform(ticketCategoryOf),
  assignee: maybe(120),
  updated: maybe(40),
  epic: maybe(40),
  prs: z.array(TicketPrSchema).max(30).default([]),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const TicketsSchema = z.object({
  at: z.string().max(40),
  tickets: z.array(TicketSchema).max(1000).default([]),
});
export type EpicTickets = z.infer<typeof TicketsSchema>;

export const SUGGESTION_STATES = ['open', 'approved', 'dismissed'] as const;
export const SuggestionStateSchema = z.enum(SUGGESTION_STATES);
export type SuggestionState = z.infer<typeof SuggestionStateSchema>;

export const SuggestionSchema = z.object({
  id: z.number().int().min(1),
  text: z.string().min(1).max(2000),
  why: z.string().max(2000).optional(),
  kind: z.enum(['jira', 'slack', 'calendar', 'task', 'doc', 'other']).default('other'),
  state: SuggestionStateSchema.default('open'),
  createdAt: z.string().max(40).optional(),
  resolvedAt: z.string().max(40).optional(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const SuggestionsSchema = z.array(SuggestionSchema).max(500);

export type InitiativeChat = {
  readonly id: string;
  readonly channel: string;
  readonly createdAt: number;
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
  readonly docs: readonly string[];
  readonly repos: readonly string[];
  readonly meetings: readonly MeetingRef[];
  readonly people: readonly InitiativePerson[];
  readonly progress?: EpicStatus;
  readonly tickets?: EpicTickets;
  readonly suggestions: readonly Suggestion[];
  readonly openDecisions: readonly string[];
  readonly recent: readonly string[];
  readonly files: readonly string[];
  readonly checkIn?: string;
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
  | { type: 'initiatives_off' };

export const reduceInitiatives = (state: InitiativesSlice, action: InitiativesAction): InitiativesSlice => {
  const current = state.initiatives;
  if (action.type === 'initiatives_init') return { initiatives: { ...action.state, ...(current.backup ? { backup: current.backup } : {}) } };
  if (action.type === 'initiatives_backup') {
    const { backup: _was, ...rest } = current;
    return { initiatives: action.backup ? { ...rest, backup: action.backup } : rest };
  }
  if (action.type === 'initiatives_off') return { initiatives: NO_INITIATIVES };
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

const sectionLines = (markdown: string, heading: RegExp): string[] => {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^#{1,3}\s/.test(l) && heading.test(l));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3}\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
};

export const openDecisionsOf = (markdown: string): string[] =>
  sectionLines(markdown, /\bopen\b/i)
    .map(bullet)
    .filter((b): b is string => Boolean(b));

export const recentOf = (markdown: string, max = 8): string[] =>
  markdown
    .split('\n')
    .map(bullet)
    .filter((b): b is string => Boolean(b))
    .slice(0, max);

export const openSuggestions = (item: Pick<InitiativeView, 'suggestions'>): Suggestion[] => item.suggestions.filter((s) => s.state === 'open');

export const progressShare = (progress: EpicStatus | undefined): number | undefined => {
  if (!progress || progress.total <= 0) return undefined;
  return Math.min(1, Math.max(0, progress.done / progress.total));
};

export const suggestionMessage = (suggestion: Pick<Suggestion, 'id' | 'text'>): string => `Do suggestion ${suggestion.id}: ${suggestion.text}`;

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

export const ticketGroups = (tickets: readonly Ticket[], epics: readonly string[]): TicketGroup[] => {
  const sorted = sortedTickets(tickets);
  if (epics.length < 2) return sorted.length ? [{ tickets: sorted }] : [];
  const known = epics.map((epic): TicketGroup => ({ epic, tickets: sorted.filter((t) => t.epic === epic) }));
  const rest = sorted.filter((t) => !t.epic || !epics.includes(t.epic));
  return [...known, ...(rest.length ? [{ tickets: rest }] : [])].filter((g) => g.tickets.length);
};

export const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((key) => b.includes(key));
