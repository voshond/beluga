import { z } from 'zod';
import { type OutboxDraft, type OutboxTarget, WATCH_CHAT, initiativeChatOf, targetWords } from './model.js';

/** The chat a watch run wakes (model.ts): its own, so the Check-in chat's history stays readable. */
export { WATCH_CHAT, WATCH_TITLE } from './model.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A watch that heard nothing this long gets a nudge drafted, once. */
export const WATCH_NUDGE_DAYS = 7;
/** A watch gives up this long after it started, unless it says otherwise (`until`). */
export const WATCH_GIVE_UP_DAYS = 14;
/** Looks happen on weekdays, from WORK_START to WORK_END (local time). */
const WORK_START = 8;
const WORK_END = 18;

const maybe = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || undefined)
    .optional();

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** Where a watch looks: a Slack conversation or thread, a Jira ticket, a doc, or a pull request. */
export const WatchPlaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slack'), channel: z.string().min(1).max(80), thread: z.string().max(40).optional(), label: z.string().max(200).optional() }),
  z.object({ kind: z.literal('jira'), issue: z.string().regex(JIRA_KEY), label: z.string().max(200).optional() }),
  z.object({ kind: z.literal('doc'), ref: z.string().min(1).max(500), label: z.string().max(200).optional() }),
  z.object({ kind: z.literal('pr'), url: z.string().min(1).max(500), label: z.string().max(200).optional() }),
]);
export type WatchPlace = z.infer<typeof WatchPlaceSchema>;

/** What a look found: what came in, from whom, what it changes; shown as "New since you asked" until read. */
export const WatchNewsSchema = z.object({
  at: z.string().max(40),
  from: maybe(120),
  text: z.string().min(1).max(2000),
  read: z.boolean().default(false),
});
export type WatchNews = z.infer<typeof WatchNewsSchema>;

export const WATCH_STATES = ['watching', 'answered', 'stopped', 'expired'] as const;
export type WatchState = (typeof WATCH_STATES)[number];

/** One follow-up the agent keeps looking for by itself (watches.json). */
export const WatchSchema = z.object({
  id: z.number().int().min(1),
  what: z.string().trim().min(1).max(500),
  where: WatchPlaceSchema,
  /** Who it waits on, a plain name. */
  waitingOn: maybe(120),
  /** The suggestion (or decision) it belongs to, and the outbox draft that started it. */
  suggestion: z.number().int().min(1).optional(),
  draft: z.number().int().min(1).optional(),
  since: z.string().max(40),
  /** Hours between looks; none: it backs off (hourly the first day, every four hours, daily after three days). */
  every: z.number().int().min(1).max(168).optional(),
  lastLook: maybe(40),
  /** When it gives up; none: WATCH_GIVE_UP_DAYS after `since`. */
  until: maybe(40),
  nudgedAt: maybe(40),
  state: z.enum(WATCH_STATES).default('watching'),
  news: z.array(WatchNewsSchema).max(50).default([]),
});
export type Watch = z.infer<typeof WatchSchema>;

export const WatchesSchema = z.array(WatchSchema).max(200);

/** What the owner gives to add one (the page, or the chat on their word). */
export const WatchDraftSchema = z.object({
  what: z.string().trim().min(1).max(500),
  where: WatchPlaceSchema,
  waitingOn: z.string().trim().max(120).optional(),
  suggestion: z.number().int().min(1).optional(),
  every: z.number().int().min(1).max(168).optional(),
});
export type WatchDraft = z.input<typeof WatchDraftSchema>;

const timeOf = (iso: string | undefined): number | undefined => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : undefined;
};

/** Hours between looks for a watch this old. */
export const watchEvery = (watch: Pick<Watch, 'every'>, age: number): number => {
  if (watch.every) return watch.every;
  if (age < DAY) return 1;
  if (age < 3 * DAY) return 4;
  return 24;
};

/** When it next looks, before working hours are applied. */
export const nextLookAt = (watch: Pick<Watch, 'since' | 'lastLook' | 'every'>): number => {
  const since = timeOf(watch.since) ?? 0;
  const base = timeOf(watch.lastLook) ?? since;
  return base + watchEvery(watch, base - since) * HOUR;
};

export const givesUpAt = (watch: Pick<Watch, 'since' | 'until'>): number => timeOf(watch.until) ?? (timeOf(watch.since) ?? 0) + WATCH_GIVE_UP_DAYS * DAY;

/** The moment itself when it falls on a weekday's working hours, else the next weekday at WORK_START. */
export const workingTime = (at: number): number => {
  const d = new Date(at);
  const working = (x: Date): boolean => x.getDay() >= 1 && x.getDay() <= 5 && x.getHours() >= WORK_START && x.getHours() < WORK_END;
  if (working(d)) return at;
  const next = new Date(d);
  if (d.getHours() >= WORK_START) next.setDate(next.getDate() + 1);
  next.setHours(WORK_START, 0, 0, 0);
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  return next.getTime();
};

/** When its next look happens: on working hours, never before now. */
export const nextLookWhen = (watch: Pick<Watch, 'since' | 'lastLook' | 'every'>, now: number): number => workingTime(Math.max(nextLookAt(watch), now));

export const isWatching = (watch: Pick<Watch, 'state'>): boolean => watch.state === 'watching';

export const isDue = (watch: Watch, now: number): boolean => isWatching(watch) && workingTime(nextLookAt(watch)) <= now;

export const dueWatches = (watches: readonly Watch[], now: number): Watch[] => watches.filter((w) => isDue(w, now));

/** Waited WATCH_NUDGE_DAYS with nothing back, and not nudged yet. */
export const needsNudge = (watch: Watch, now: number): boolean => isWatching(watch) && !watch.nudgedAt && !watch.news.length && now - (timeOf(watch.since) ?? now) >= WATCH_NUDGE_DAYS * DAY;

export const isExpired = (watch: Watch, now: number): boolean => isWatching(watch) && now >= givesUpAt(watch);

/** The earliest moment a watch is due (on working hours), or undefined with nothing to watch. */
export const nextWakeAt = (watches: readonly Watch[], now: number): number | undefined => {
  const times = watches.filter(isWatching).map((w) => nextLookWhen(w, now));
  return times.length ? Math.min(...times) : undefined;
};

export type UnreadNews = { readonly watch: Watch; readonly news: WatchNews };

/** "New since you asked": unread news, newest first. */
export const unreadNews = (watches: readonly Watch[]): UnreadNews[] =>
  watches
    .flatMap((watch) => watch.news.filter((n) => !n.read).map((news) => ({ watch, news })))
    .sort((a, b) => (timeOf(b.news.at) ?? 0) - (timeOf(a.news.at) ?? 0));

export const watchPlaceWords = (where: WatchPlace): string => {
  if (where.kind === 'slack' || where.kind === 'jira') return targetWords(where);
  if (where.kind === 'pr') return where.label ? `pull request ${where.label}` : where.url;
  return where.label ?? where.ref;
};

/** A link to the place, when it has one the page can open. */
export const watchPlaceLink = (where: WatchPlace): string | undefined => {
  if (where.kind === 'doc') return /^https?:\/\//i.test(where.ref) ? where.ref : undefined;
  if (where.kind === 'pr') return /^https?:\/\//i.test(where.url) ? where.url : undefined;
  return undefined;
};

const SLACK_LINK = /\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/;
const PR_LINK = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+/i;

/** Where to look, from what the owner pasted: a Jira key, a Slack link, a pull request or any other link. */
export const watchPlaceOf = (ref: string, label?: string): WatchPlace | undefined => {
  const text = ref.trim();
  const named = label?.trim() ? { label: label.trim() } : {};
  if (!text) return undefined;
  if (JIRA_KEY.test(text.toUpperCase())) return { kind: 'jira', issue: text.toUpperCase(), ...named };
  const slack = /slack\.com/i.test(text) ? SLACK_LINK.exec(text) : null;
  if (slack) {
    const thread = /[?&]thread_ts=(\d+\.\d+)/.exec(text)?.[1] ?? (slack[2] ? `${slack[2]}.${slack[3]}` : undefined);
    return { kind: 'slack', channel: slack[1]!, ...(thread ? { thread } : {}), ...named };
  }
  if (PR_LINK.test(text)) return { kind: 'pr', url: text, ...named };
  return { kind: 'doc', ref: text, ...named };
};

const firstWords = (text: string, max = 80): string => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The watch a sent draft starts: an answer where it went. */
export const watchOfDraft = (draft: Pick<OutboxDraft, 'id' | 'to' | 'text' | 'sentText' | 'suggestion'>, id: number, now: number): Watch => {
  const to: OutboxTarget = draft.to;
  return WatchSchema.parse({
    id,
    what: `An answer to “${firstWords(draft.sentText ?? draft.text)}”`,
    where: to,
    ...(draft.suggestion ? { suggestion: draft.suggestion } : {}),
    draft: draft.id,
    since: new Date(now).toISOString(),
  });
};

export const nextWatchId = (watches: readonly Watch[]): number => watches.reduce((n, w) => Math.max(n, w.id), 0) + 1;

export const isWatchChat = (channel: string | undefined): boolean => initiativeChatOf(channel)?.chat === WATCH_CHAT;
