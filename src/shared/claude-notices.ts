import type { LogItem } from '../core/store.js';

/**
 * Words about a Claude card that aren't Claude's answer: Claude Code's own notice that a plan
 * limit was hit, Beluga's note on a queued message Claude read mid-turn, and what an answered
 * turn still waits on. Browser-safe (the core writes them, the Mac app shows them).
 */

/** What a steered message's card says while it waits in the running turn for Claude's next step. */
export const READS_AFTER_STEP = 'Your agent reads this after its current step';

/** What a steered message's card says while Claude's turn is being stopped so it reads it next (a long step, Send now). */
export const STOPPING_FOR = 'Your agent stops its current step to read this';

/** What a queued message's card says when Claude took it in while it worked (see AgentHost.steer). */
export const STEERED_IN = 'Your agent read this while it worked; the answer above covers it.';

/**
 * A steered message Claude hasn't read yet (BLG-54): its card is only a note, waiting in the
 * running turn for Claude's next step, or for the step being stopped. Once Claude reads it the
 * note says so (STEERED_IN) or the card becomes its own turn.
 */
export function steerWaiting(card: { readonly status: string; readonly text: string }): 'next_step' | 'stopping' | undefined {
  if (['done', 'error', 'denied', 'queued', 'interrupted'].includes(card.status)) return undefined;
  return card.text === READS_AFTER_STEP ? 'next_step' : card.text === STOPPING_FOR ? 'stopping' : undefined;
}

/** A message you steered in, as a screen shows it: on the message itself (BLG-54). */
export interface SteeredMessage {
  /** The request it is (Send now: host.steerNow). */
  readonly request: string;
  /** Still waiting to be read: at Claude's next step, or while its step is being stopped for it. */
  readonly waiting: 'next_step' | 'stopping';
}

/**
 * Your steered messages as the chat shows them: those Claude hasn't read yet (by message id),
 * and the note cards that say so (drawn on the message instead, so not drawn themselves).
 * Only messages that know their request (`request`, said in a workspace) are linked; others keep
 * their note card.
 */
export function steeredMessages(items: readonly LogItem[]): { readonly waiting: ReadonlyMap<string, SteeredMessage>; readonly notes: ReadonlySet<string> } {
  const waiting = new Map<string, SteeredMessage>();
  const notes = new Set<string>();
  const asked = new Map<string, string>();
  for (const l of items) if (l.type === 'chat' && l.request) asked.set(l.request, l.id);
  if (!asked.size) return { waiting, notes };
  const cards = new Set<string>();
  for (const l of items) {
    if (l.type !== 'agent') continue;
    const message = asked.get(l.requestId);
    if (!message) continue;
    cards.add(l.requestId);
    const how = steerWaiting(l);
    if (how) waiting.set(message, { request: l.requestId, waiting: how });
    if (how || (l.status === 'done' && l.text === STEERED_IN)) notes.add(l.id);
  }
  // Sent to steer, its card not here yet: not read (so the line under it doesn't appear a moment later).
  for (const l of items) if (l.type === 'chat' && l.steer && l.request && !cards.has(l.request)) waiting.set(l.id, { request: l.request, waiting: 'next_step' });
  return { waiting, notes };
}

type AgentCard = Extract<LogItem, { type: 'agent' }>;

/** What a queued message's card says once it came out of the queue unsent (Stop, Remove, Edit: see AgentHost). */
const NOT_SENT = /^(Taken out of the queue|Cancelled before it started)/;

/** Rows moved to when they ran, the same object each time while it's the same row (so a row's memo holds). */
const ranAt = new WeakMap<LogItem, LogItem>();
function at(item: LogItem, ts: number): LogItem {
  const was = ranAt.get(item);
  if (was?.ts === ts) return was;
  const row = { ...item, ts };
  ranAt.set(item, row);
  return row;
}

/**
 * A conversation's items as the chat draws them around the queue above the box (BLG-317). A
 * message waiting its turn is in the queue, not the chat: it and its card aren't drawn, nor once
 * it came out of the queue unsent (it went back to the box, or was dropped). Once it runs, both
 * are drawn where it ran (when it left the queue: after what Claude said meanwhile), not back
 * where it was typed. A message waiting for a free Claude (nothing runs here) stays in the chat,
 * where it can start now. `inQueue`: a card the queue above the box shows while it waits.
 */
export function asSent(items: readonly LogItem[], inQueue: (card: AgentCard) => boolean): readonly LogItem[] {
  const hidden = new Set<string>();
  const ran = new Map<string, number>();
  for (const l of items) {
    if (l.type !== 'agent' || !inQueue(l)) continue;
    if ((l.status === 'queued' && !l.slotWait) || (l.status === 'error' && l.queuedUntil !== undefined && NOT_SENT.test(l.text))) hidden.add(l.requestId);
    else if (l.queuedUntil !== undefined && l.status !== 'queued') ran.set(l.requestId, l.queuedUntil);
  }
  if (!hidden.size && !ran.size) return items;
  return moveRequests(items, hidden, ran);
}

const requestOf = (l: LogItem): string | undefined => (l.type === 'agent' ? l.requestId : l.type === 'chat' ? l.request : undefined);

/** The items with each request in `hidden` left out, and each in `to` (its message and card) moved to that time: after everything said before then. */
function moveRequests(items: readonly LogItem[], hidden: ReadonlySet<string>, to: ReadonlyMap<string, number>): LogItem[] {
  const moved = new Map<string, LogItem[]>();
  const rows: LogItem[] = [];
  for (const l of items) {
    const request = requestOf(l);
    if (request === undefined || !(hidden.has(request) || to.has(request))) rows.push(l);
    else if (to.has(request)) moved.set(request, [...(moved.get(request) ?? []), at(l, to.get(request)!)]);
  }
  for (const [request, when] of [...to].sort((a, b) => a[1] - b[1])) {
    const these = moved.get(request);
    if (!these) continue;
    const i = rows.findIndex((r) => r.ts > when);
    rows.splice(i < 0 ? rows.length : i, 0, ...these);
  }
  return rows;
}

/**
 * Your steered messages placed where the agent read them (BLG-47): one it read is drawn (with its
 * card) at the moment it did, so what the agent did before then stays above it; one it hasn't read
 * yet is `pinned`, drawn below everything (the working turn too) until it does. `waiting`: the
 * unread ones, by message id (see steeredMessages).
 */
export function asRead(items: readonly LogItem[], waiting: ReadonlyMap<string, SteeredMessage>): { readonly rows: readonly LogItem[]; readonly pinned: readonly LogItem[] } {
  const unread = new Set([...waiting.values()].map((x) => x.request));
  const read = new Map<string, number>();
  for (const l of items) if (l.type === 'agent' && l.readAt !== undefined && !unread.has(l.requestId)) read.set(l.requestId, l.readAt);
  if (!unread.size && !read.size) return { rows: items, pinned: [] };
  const pinned = items.filter((l) => l.type === 'chat' && waiting.has(l.id));
  return { rows: moveRequests(items, unread, read), pinned };
}

/**
 * Claude Code stopping at a usage limit: "You've hit your limit · resets 3pm", "You've hit your
 * session limit", "Claude AI usage limit reached|…", "5-hour limit reached ∙ resets 9pm".
 */
const LIMIT = /(you['’]ve hit your (?:[\w-]+ )?limit|usage limit reached|(?:session|weekly|5-hour|opus|sonnet)(?: weekly)? limit reached)/i;

/** Whether a card's words are Claude Code's limit notice (short, so an answer about limits isn't). */
export function isLimitNotice(text: string): boolean {
  const last = text.trim().split(/\n+/).at(-1) ?? '';
  return last.length <= 200 && LIMIT.test(last);
}

/**
 * Claude answered but its run waits on work it left going in the background (sub-agents,
 * background shells): what, so the chat doesn't look finished. Undefined: nothing waits.
 */
export function backgroundWait(items: readonly LogItem[]): string | undefined {
  const card = [...items].reverse().find((l): l is Extract<LogItem, { type: 'agent' }> => l.type === 'agent' && l.status !== 'queued');
  if (!card || ['done', 'error', 'denied'].includes(card.status) || !card.text) return undefined;
  const live = card.subagents.filter((x) => x.status === 'running');
  if (!live.length) return undefined;
  const noun = live.every((x) => x.kind !== 'background') ? 'background agent' : live.every((x) => x.kind === 'background') ? 'background task' : 'background job';
  return `Waiting on ${live.length} ${noun}${live.length === 1 ? '' : 's'} · ${live.map((x) => x.title).join(', ')}`;
}
