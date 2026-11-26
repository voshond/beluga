import { z } from 'zod';
import { INITIATIVE_SLUG, type InitiativePerson, type InitiativeView, type Suggestion, type TimelineEntry, type TimelineKind, slugOf } from './model.js';

/** The directory's folder at the repo's root: one `<slug>.json` per person, shared by every initiative. */
export const PEOPLE_DIR = 'people';

const text = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() ?? '');

/** A field most entries don't have: left out of the file when empty. */
const extra = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || undefined)
    .optional();

/** One person, stored once (people/<slug>.json): who they are, what they care about, how to reach them. */
export const DirectoryPersonSchema = z.object({
  name: z.string().trim().min(1).max(120),
  cares: text(2000),
  slack: text(120),
  /** Slack's own id for them (U…): stable when they rename. */
  slackId: extra(40),
  jira: text(120),
  /** Jira's accountId: what JQL and mentions take. */
  jiraId: extra(128),
  github: extra(80),
  email: extra(200),
  /** Their job title, as Slack or the directory has it. */
  title: extra(200),
  /** Where their picture comes from (https); Beluga keeps a copy (avatars.ts). */
  avatar: extra(1000),
  notes: text(4000),
});
export type DirectoryPerson = z.infer<typeof DirectoryPersonSchema>;

export type Person = DirectoryPerson & { readonly slug: string };

/** What the page sends to add or edit one: no slug makes a new entry. */
export const PersonDraftSchema = DirectoryPersonSchema.extend({ slug: z.string().regex(INITIATIVE_SLUG).optional() });
export type PersonDraft = z.input<typeof PersonDraftSchema>;

/** An open question in decisions.md that waits on someone: "- Who owns X? (waiting on: Julia)". */
export type WaitingQuestion = {
  readonly text: string;
  readonly waitingOn: string;
};

const WAITING_MARK = /\s*\((?:waiting on|waits on)\s*:?\s*([^)]+)\)\s*$/i;
const LEADING_DAY = /^\**\s*\d{4}-\d{2}-\d{2}\s*\**\s*[:–—-]\s*/;

/** decisions.md's "## Open" bullets that carry a "(waiting on: …)" mark. */
export const waitingQuestionsOf = (markdown: string): WaitingQuestion[] => {
  const out: WaitingQuestion[] = [];
  let open = false;
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      open = /^open\b/i.test(heading[1]!);
      continue;
    }
    const bullet = open ? /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1] : undefined;
    const mark = bullet ? WAITING_MARK.exec(bullet) : null;
    if (bullet && mark) out.push({ text: bullet.slice(0, mark.index).replace(LEADING_DAY, '').trim(), waitingOn: mark[1]!.trim() });
  }
  return out;
};

const squash = (value: string): string => value.trim().toLowerCase().replace(/^@/, '');

/** Whether a name, slug or handle the agent wrote means this person. */
export const isPerson = (ref: string | null | undefined, person: Pick<Person, 'slug' | 'name' | 'slack' | 'jira'> & Partial<Pick<Person, 'slackId' | 'jiraId' | 'github' | 'email'>>): boolean => {
  if (!ref?.trim()) return false;
  const said = squash(ref);
  return slugOf(ref) === person.slug || said === squash(person.name) || [person.slack, person.slackId, person.jira, person.jiraId, person.github, person.email].some((handle) => Boolean(handle) && squash(handle!) === said);
};

/** The directory entry a reference means, if any. */
export const personOf = (people: readonly Person[], ref: string | null | undefined): Person | undefined => people.find((p) => isPerson(ref, p));

/** Someone on an initiative as the page shows them: their entry (when the directory has one) and their role there. */
export type Member = {
  readonly slug: string;
  readonly name: string;
  readonly role?: string;
  readonly person?: Person;
};

export const membersOf = (item: Pick<InitiativeView, 'people'>, people: readonly Person[]): Member[] =>
  item.people.map((entry: InitiativePerson) => {
    const person = people.find((p) => p.slug === entry.person);
    return { slug: entry.person, name: person?.name ?? entry.name ?? entry.person, ...(entry.role ? { role: entry.role } : {}), ...(person ? { person } : {}) };
  });

/** Something open between the user and one person: an open suggestion or a question in decisions.md. */
export type OpenWith = {
  readonly initiative: string;
  readonly initiativeName: string;
  readonly text: string;
  readonly suggestion?: number;
};

type Who = Pick<Person, 'slug' | 'name' | 'slack' | 'jira'>;

const openOf = (item: Pick<InitiativeView, 'suggestions'>): Suggestion[] => item.suggestions.filter((s) => s.state === 'open');

/** What waits on them (they owe the user): open suggestions with them as `waitingOn`, and questions marked as waiting on them. */
export const waitingOnThem = (item: Pick<InitiativeView, 'slug' | 'name' | 'suggestions' | 'waitingQuestions'>, who: Who): OpenWith[] => [
  ...openOf(item)
    .filter((s) => isPerson(s.waitingOn, who))
    .map((s) => ({ initiative: item.slug, initiativeName: item.name, text: s.text, suggestion: s.id })),
  ...(item.waitingQuestions ?? []).filter((q) => isPerson(q.waitingOn, who)).map((q) => ({ initiative: item.slug, initiativeName: item.name, text: q.text })),
];

/** What they wait on (the user owes them): open suggestions with them as `askedBy`. */
export const waitingOnYou = (item: Pick<InitiativeView, 'slug' | 'name' | 'suggestions'>, who: Who): OpenWith[] =>
  openOf(item)
    .filter((s) => isPerson(s.askedBy, who))
    .map((s) => ({ initiative: item.slug, initiativeName: item.name, text: s.text, suggestion: s.id }));

const CONTACT_KINDS: ReadonlySet<TimelineKind> = new Set(['said', 'message', 'meeting']);

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mentions = (line: string, who: Who): boolean => {
  const first = who.name.split(/\s+/)[0] ?? '';
  const words = [who.name, first.length >= 3 ? first : '', who.slack, who.jira].filter((w) => w.trim().length >= 2);
  return words.some((word) => new RegExp(`(^|[^\\p{L}\\p{N}])@?${escape(squash(word))}(?![\\p{L}\\p{N}])`, 'iu').test(line));
};

/** The last day the timeline shows them talking with the user: a said, message or meeting line that names them. */
export const lastContact = (timeline: readonly TimelineEntry[], who: Who): string | undefined =>
  timeline
    .filter((e) => e.day && CONTACT_KINDS.has(e.kind) && mentions(e.text, who))
    .map((e) => e.day)
    .sort()
    .at(-1);

/** One person across every initiative: their roles, what is open both ways and when they last talked. */
export type PersonAcross = {
  readonly person: Person;
  readonly roles: ReadonlyArray<{ readonly initiative: string; readonly initiativeName: string; readonly role?: string }>;
  readonly waitingOnThem: readonly OpenWith[];
  readonly waitingOnYou: readonly OpenWith[];
  readonly lastContact?: string;
};

export const personAcross = (person: Person, items: readonly InitiativeView[]): PersonAcross => {
  const live = items.filter((i) => i.status !== 'archived');
  const last = live
    .map((i) => lastContact(i.timeline, person))
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);
  return {
    person,
    roles: live.flatMap((i) => i.people.filter((p) => p.person === person.slug).map((p) => ({ initiative: i.slug, initiativeName: i.name, ...(p.role ? { role: p.role } : {}) }))),
    waitingOnThem: live.flatMap((i) => waitingOnThem(i, person)),
    waitingOnYou: live.flatMap((i) => waitingOnYou(i, person)),
    ...(last ? { lastContact: last } : {}),
  };
};

/** Everyone in the directory, those with the most open first, then by name. */
export const peopleAcross = (people: readonly Person[], items: readonly InitiativeView[]): PersonAcross[] => {
  const open = (p: PersonAcross): number => p.waitingOnThem.length + p.waitingOnYou.length;
  return people.map((p) => personAcross(p, items)).sort((a, b) => open(b) - open(a) || a.person.name.localeCompare(b.person.name));
};

/** Whether the one-time people.md pass is still to come: nobody on it yet, and no people suggestion so far. */
export const needsPeoplePass = (item: Pick<InitiativeView, 'people' | 'suggestions' | 'files'>): boolean =>
  !item.people.length && item.files.includes('people.md') && !item.suggestions.some((s) => s.people?.length);

/** Who a suggestion's waitingOn or askedBy names, in words. */
export const personName = (people: readonly Person[], ref: string | null | undefined): string | undefined => (ref?.trim() ? (personOf(people, ref)?.name ?? ref.trim()) : undefined);
