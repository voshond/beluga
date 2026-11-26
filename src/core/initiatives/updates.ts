import { z } from 'zod';
import type { Audience, AudienceTarget, Cadence } from './audience.js';
import { type InitiativeView, type OutboxDraft, OutboxTargetSchema, type Ticket, type TimelineEntry, isDecision, uniqueSlug } from './model.js';
import { type Person, personOf } from './people.js';

/** Where sent updates and kept prep sheets go, one Markdown file each. */
export const UPDATES_DIR = 'updates';

const TicketMarkSchema = z.object({
  key: z.string().min(1).max(40),
  summary: z.string().max(500).default(''),
  status: z.string().max(80).default(''),
  done: z.boolean().default(false),
  assignee: z.string().max(120).optional(),
});
export type TicketMark = z.infer<typeof TicketMarkSchema>;

/** One update sent to an audience (or a prep sheet kept), which Beluga writes: what went where, and the tickets as they stood then, for the next one's delta. */
export const UpdateRecordSchema = z.object({
  audience: z.string().max(40),
  at: z.string().max(40),
  draft: z.number().int().min(1),
  to: OutboxTargetSchema,
  file: z.string().max(400),
  tickets: z.array(TicketMarkSchema).max(1000).default([]),
});
export type UpdateRecord = z.infer<typeof UpdateRecordSchema>;

export const UpdatesSchema = z.array(UpdateRecordSchema).max(2000);

export const ticketMarks = (tickets: readonly Ticket[]): TicketMark[] =>
  tickets.map((t) => ({ key: t.key, summary: t.summary, status: t.status, done: t.statusCategory === 'done', ...(t.assignee ? { assignee: t.assignee } : {}) }));

const DAY = 24 * 60 * 60 * 1000;

const slotOn = (day: Date, at: string): Date => {
  const [hours, minutes] = at.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours ?? 0, minutes ?? 0);
};

/** The first slot of a cadence after a time (local time), none for one on request only. */
export const nextSlot = (cadence: Cadence, after: number): number | undefined => {
  if (!cadence.days.length) return undefined;
  for (let n = 0; n <= 8; n += 1) {
    const slot = slotOn(new Date(after + n * DAY), cadence.at);
    if (slot.getTime() > after && cadence.days.includes(slot.getDay())) return slot.getTime();
  }
  return undefined;
};

/** The latest slot at or before a time. */
export const lastSlot = (cadence: Cadence, before: number): number | undefined => {
  if (!cadence.days.length) return undefined;
  for (let n = 0; n <= 8; n += 1) {
    const slot = slotOn(new Date(before - n * DAY), cadence.at);
    if (slot.getTime() <= before && cadence.days.includes(slot.getDay())) return slot.getTime();
  }
  return undefined;
};

const timeOf = (iso: string | undefined): number | undefined => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : undefined;
};

export const lastUpdateOf = (item: Pick<InitiativeView, 'updates'>, audience: string): UpdateRecord | undefined =>
  (item.updates ?? []).filter((u) => u.audience === audience).reduce<UpdateRecord | undefined>((latest, u) => ((timeOf(u.at) ?? 0) >= (timeOf(latest?.at) ?? -1) ? u : latest), undefined);

/** Its draft still waiting for the user, or on its way out. */
export const pendingUpdateOf = (item: Pick<InitiativeView, 'outbox'>, audience: string): OutboxDraft | undefined =>
  item.outbox.find((d) => d.audience === audience && (d.state === 'draft' || d.state === 'approved'));

/** When its next update is due: the first slot after the last one sent, or, never sent, the latest slot so far. */
export const nextDueOf = (item: Pick<InitiativeView, 'updates'>, audience: Pick<Audience, 'id' | 'cadence'>, now: number): number | undefined => {
  const last = timeOf(lastUpdateOf(item, audience.id)?.at);
  if (last !== undefined) return nextSlot(audience.cadence, last);
  return lastSlot(audience.cadence, now) ?? nextSlot(audience.cadence, now);
};

/** Due, and no draft for it waiting already. */
export const isUpdateDue = (item: Pick<InitiativeView, 'updates' | 'outbox'>, audience: Pick<Audience, 'id' | 'cadence'>, now: number): boolean => {
  const due = nextDueOf(item, audience, now);
  return due !== undefined && due <= now && !pendingUpdateOf(item, audience.id);
};

export const dueAudiences = (item: Pick<InitiativeView, 'audiences' | 'updates' | 'outbox'>, now: number): Audience[] => (item.audiences ?? []).filter((a) => isUpdateDue(item, a, now));

export type TicketDelta = {
  readonly done: readonly TicketMark[];
  readonly moved: ReadonlyArray<{ readonly ticket: TicketMark; readonly from: string }>;
  readonly added: readonly TicketMark[];
  readonly reassigned: ReadonlyArray<{ readonly ticket: TicketMark; readonly from?: string }>;
  readonly gone: readonly TicketMark[];
};

/** How the tickets moved since a snapshot: newly done, other status changes, new ones, new assignees, and ones no longer read. */
export const ticketDelta = (before: readonly TicketMark[], tickets: readonly Ticket[]): TicketDelta => {
  const now = ticketMarks(tickets);
  const was = new Map(before.map((t) => [t.key, t]));
  const known = (t: TicketMark): t is TicketMark => was.has(t.key);
  const old = now.filter(known);
  return {
    done: old.filter((t) => t.done && !was.get(t.key)!.done),
    moved: old.filter((t) => !t.done && t.status !== was.get(t.key)!.status).map((ticket) => ({ ticket, from: was.get(ticket.key)!.status })),
    added: now.filter((t) => !was.has(t.key)),
    reassigned: old.filter((t) => (t.assignee ?? '') !== (was.get(t.key)!.assignee ?? '')).map((ticket) => ({ ticket, ...(was.get(ticket.key)!.assignee ? { from: was.get(ticket.key)!.assignee } : {}) })),
    gone: before.filter((t) => !now.some((n) => n.key === t.key)),
  };
};

const named = (t: TicketMark): string => `${t.key}${t.summary ? ` ${t.summary}` : ''}`;

export const deltaLines = (delta: TicketDelta): string[] => [
  ...delta.done.map((t) => `done: ${named(t)}`),
  ...delta.moved.map(({ ticket, from }) => `moved: ${named(ticket)} (${from || 'no status'} → ${ticket.status || 'no status'})`),
  ...delta.added.map((t) => `new: ${named(t)} (${t.status || 'no status'}${t.assignee ? `, ${t.assignee}` : ''})`),
  ...delta.reassigned.map(({ ticket, from }) => `reassigned: ${ticket.key} (${from ?? 'nobody'} → ${ticket.assignee ?? 'nobody'})`),
  ...delta.gone.map((t) => `no longer under the epics: ${named(t)}`),
];

const dayOfTime = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** Timeline lines since a time (the day of it included), skipping the updates' own lines. */
export const timelineSince = (timeline: readonly TimelineEntry[], since: number | undefined): TimelineEntry[] => {
  const from = since === undefined ? undefined : dayOfTime(since);
  return timeline.filter((e) => e.kind !== 'update' && (from === undefined || (e.day !== '' && e.day >= from)));
};

/** Decisions the user made since a time: the question and the answer. */
export const decisionsSince = (item: Pick<InitiativeView, 'suggestions'>, since: number | undefined): string[] =>
  item.suggestions
    .filter((s) => s.state === 'approved' && isDecision(s) && (since === undefined || (timeOf(s.resolvedAt) ?? 0) >= since))
    .map((s) => `${s.text} → ${s.answer ?? 'approved'}`);

const nameOf = (people: readonly Person[], ref: string): string => personOf(people, ref)?.name ?? ref;

/** What is open and with whom: what waits on someone, what someone waits on the user for, and the open questions marked as waiting. */
export const openWithWhom = (item: Pick<InitiativeView, 'suggestions' | 'waitingQuestions'>, people: readonly Person[]): string[] => {
  const open = item.suggestions.filter((s) => s.state === 'open');
  return [
    ...open.filter((s) => s.waitingOn).map((s) => `waiting on ${nameOf(people, s.waitingOn!)}: ${s.text}`),
    ...open.filter((s) => s.askedBy).map((s) => `${nameOf(people, s.askedBy!)} waits on the user: ${s.text}`),
    ...(item.waitingQuestions ?? []).map((q) => `waiting on ${nameOf(people, q.waitingOn)}: ${q.text}`),
  ];
};

/** A new audience's id from its name. */
export const audienceIdOf = (name: string, taken: readonly string[]): string => uniqueSlug(name, new Set(taken));

const SLACK_LINK = /\/archives\/([A-Z0-9]{6,})(?:\/p(\d{10})(\d{6}))?/;

/** A Slack target from what was pasted: a message link (its channel and thread), a channel id, or a #name the agent resolves. */
export const slackTargetOf = (said: string, label?: string): Extract<AudienceTarget, { kind: 'slack' }> => {
  const text = said.trim();
  const link = SLACK_LINK.exec(text);
  const threadParam = /[?&]thread_ts=(\d{10}\.\d{6})/.exec(text)?.[1];
  const tail = label?.trim() ? { label: label.trim() } : {};
  if (!link) return { kind: 'slack', channel: text, ...tail };
  const thread = threadParam ?? (link[2] ? `${link[2]}.${link[3]}` : undefined);
  return { kind: 'slack', channel: link[1]!, ...(thread ? { thread } : {}), ...tail };
};

/** Where it goes, for a person to read. */
export const audienceTargetWords = (target: AudienceTarget): string => {
  if (target.kind === 'slack') return `${target.label ?? target.channel}${target.thread ? ' (in a thread)' : ''}`;
  if (target.kind === 'confluence') return `${target.label ?? `Confluence page ${target.page}`} › ${target.section}`;
  return `prep sheet for ${target.label ?? target.meeting}`;
};
