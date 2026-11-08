// Relative paths (not @beluga/…) so the unit tests at the repo root can load this model too.
import type { LogItem, SubAgent } from '../../../../src/core/store.js';
import type { StepSummary } from '../../../../src/shared/steps.js';
import { READS_AFTER_STEP, STEERED_IN, STOPPING_FOR, TAKEN_BACK, backgroundWait } from '../../../../src/shared/claude-notices.js';
import { HIDDEN_STEPS, isRunning } from '../../../../src/ui/format.js';

/**
 * Where a Claude turn is drawn when you said something while it worked (BLG-22). Messages sent
 * mid-turn (steered in, or waiting their turn) land below the turn's card, so the card would sit
 * above them looking stuck while Claude goes on. Instead the turn is drawn in two parts: its
 * head stays where the turn began, with the steps, background work and words it had finished
 * before your first message (BLG-45);
 * its tail (what it does since: the step it's on, background work, the working line, its
 * answer) comes after what you said: at the very bottom while it runs, and stays there once it
 * has answered, so nothing jumps or vanishes when the turn ends.
 */

type AgentItem = Extract<LogItem, { type: 'agent' }>;

/** The least a chat row needs here (a log item, or a task drawn in the chat). */
export interface RowLike {
  readonly type: string;
  readonly id: string;
  readonly ts: number;
}

/**
 * Which part of a turn a row draws: the head (where it began), the tail (after what was said
 * since), or its live part: the work it left running (sub-agents, background jobs) once another
 * turn of the same Claude took over, drawn at the very bottom (BLG-54).
 */
export interface TurnPart {
  readonly side: 'head' | 'tail' | 'live';
  /** When the first message said during the turn came: the head keeps the steps finished before it. */
  readonly cut: number;
}

/** A row as the chat draws it: a whole row, or one part of a split turn (keyed apart). */
export interface Shown<R extends RowLike> {
  readonly row: R;
  readonly key: string;
  readonly part?: TurnPart;
  /**
   * The working line goes at the end of this row, saying what this turn does (the one its Claude
   * is on: this row's, or another's when this is a live part). One per Claude at work: its last row.
   */
  readonly working?: AgentItem;
  /** Which of its sub-agents and background work the row draws: `settled` (the running ones are in its live part), or only the `running` ones (the live part). All, when unset. */
  readonly subs?: 'running' | 'settled';
}

const isAgent = (r: RowLike): r is RowLike & AgentItem => r.type === 'agent';

/** A card that's a note about a message (queued, read mid-turn, about to be read, taken back), not a turn of its own. */
export function isTurnNote(card: Pick<AgentItem, 'status' | 'text'>): boolean {
  return card.status === 'queued' || card.text === STEERED_IN || card.text === READS_AFTER_STEP || card.text === STOPPING_FOR || card.text === TAKEN_BACK;
}

/** A turn Claude is working on now (not waiting in the queue, not a note). */
export function isLiveTurn(card: Pick<AgentItem, 'status' | 'text'>): boolean {
  return isRunning(card.status) && !isTurnNote(card);
}

const isTurn = (r: RowLike): r is RowLike & AgentItem => isAgent(r) && !isTurnNote(r);
const leftRunning = (card: AgentItem): boolean => card.subagents.some((x) => x.status === 'running');

/**
 * The chat's rows with each turn that had things said during it split in two: its head in
 * place, its tail after them (the very end while it runs). A turn nobody spoke during is drawn
 * whole, as before. What counts as said during a turn: rows after its card from before it ended
 * (messages, notes about them, tasks, system lines), up to the next turn of its own.
 *
 * A Claude is on one turn at a time (BLG-54). A card still running when a later turn of the same
 * Claude began (your message got a turn of its own, a follow-up went into its run) was taken
 * over: it's drawn as if it ended there (its tail before that turn) and never with a working
 * line; what it left running (sub-agents, background jobs) is its live part, at the very bottom.
 * There is one working line per Claude at work, on the last row of its live work, saying what
 * the turn it's on does.
 */
export function withLiveTails<R extends RowLike>(rows: readonly R[]): Shown<R>[] {
  /** A running turn's index → the later turn of the same Claude that took over from it. */
  const takenOver = new Map<number, number>();
  rows.forEach((row, i) => {
    if (!isAgent(row) || !isLiveTurn(row)) return;
    const next = rows.findIndex((r, j) => j > i && isTurn(r) && r.owner === row.owner);
    if (next >= 0) takenOver.set(i, next);
  });
  /** Tails to draw after a row's index; -1: at the very end. */
  const after = new Map<number, Shown<R>[]>();
  const heads = new Map<number, Shown<R>>();
  rows.forEach((row, i) => {
    if (!isTurn(row)) return;
    const over = takenOver.get(i);
    const live = isLiveTurn(row) && over === undefined;
    const end = live ? Infinity : over !== undefined ? rows[over]!.ts : row.endTs;
    if (end === undefined) return;
    let first = -1;
    let last = -1;
    for (let j = i + 1; j < rows.length; j++) {
      const r = rows[j]!;
      if (isTurn(r)) {
        // Another turn: a finished one's tail goes before it; a running one's still goes to the end.
        if (!live) break;
        continue;
      }
      // Taken over: what was said up to when the next turn began (in the same moment, your message and its card) counts.
      if (over !== undefined ? r.ts > end : r.ts >= end) break;
      if (first < 0) first = j;
      last = j;
    }
    if (first < 0) return;
    const cut = rows[first]!.ts;
    heads.set(i, { row, key: row.id, part: { side: 'head', cut } });
    const at = live ? -1 : last;
    after.set(at, [...(after.get(at) ?? []), { row, key: `${row.id}:tail`, part: { side: 'tail', cut } }]);
  });
  const out: Shown<R>[] = [];
  rows.forEach((row, i) => {
    out.push(heads.get(i) ?? { row, key: row.id });
    out.push(...(after.get(i) ?? []));
  });
  out.push(...(after.get(-1) ?? []));
  return withWorkingLines(rows, out, takenOver);
}

/**
 * Each Claude at work gets one working line, on the last of its rows still at work: the turn it's
 * on, or the live part of a turn it left work running in, drawn at the very end (see withLiveTails).
 */
function withWorkingLines<R extends RowLike>(rows: readonly R[], out: Shown<R>[], takenOver: ReadonlyMap<number, number>): Shown<R>[] {
  const claudes = new Map<string, { on?: AgentItem; newest?: AgentItem; left: AgentItem[] }>();
  rows.forEach((row, i) => {
    if (!isAgent(row) || !isLiveTurn(row)) return;
    const c = claudes.get(row.owner) ?? { left: [] };
    if (!takenOver.has(i)) c.on = row;
    else if (leftRunning(row)) c.left.push(row);
    c.newest = row;
    claudes.set(row.owner, c);
  });
  if (!claudes.size) return out;
  const left = new Set([...claudes.values()].flatMap((c) => c.left.map((x) => x.id)));
  const shown: Shown<R>[] = left.size ? out.map((x) => (left.has(x.row.id) ? { ...x, subs: 'settled' as const } : x)) : out;
  for (const c of claudes.values()) {
    // Every running card taken over and nothing left running: the newest still has its line, at the end.
    const live = c.left.length ? c.left : c.on ? [] : c.newest ? [c.newest] : [];
    for (const card of live) shown.push({ row: card as unknown as R, key: `${card.id}:live`, part: { side: 'live', cut: card.ts }, subs: 'running' });
  }
  for (const [owner, c] of claudes) {
    const speaksFor = c.on ?? c.newest;
    let at = shown.length - 1;
    for (; at >= 0; at--) {
      const x = shown[at]!;
      if (isAgent(x.row) && x.row.owner === owner && (x.part?.side === 'live' || (x.row.id === c.on?.id && x.part?.side !== 'head'))) break;
    }
    if (speaksFor && at >= 0) shown[at] = { ...shown[at]!, working: speaksFor };
  }
  return shown;
}

/** When a step ended (its start, when it never said). */
const endOf = (step: StepSummary): number => step.endedAt ?? (step.durationMs !== undefined ? step.startedAt + step.durationMs : step.startedAt);

/**
 * Whether a step of a split turn is drawn in its head: it had finished before the first message
 * said during the turn. One still running, or finishing after it, is the tail's; so are one-line
 * steps without times (a friend's Claude), which can't be placed.
 */
export function inHead(step: StepSummary, cut: number): boolean {
  if (step.id.startsWith('line-') || step.status === 'running') return false;
  return endOf(step) <= cut;
}

/** Whether a sub-agent or background work of a split turn is drawn in its head: it had finished before the cut. */
export function subInHead(sub: SubAgent, cut: number): boolean {
  return sub.status !== 'running' && sub.endedAt !== undefined && sub.endedAt <= cut;
}

/**
 * A card's words for the part of it drawn: a split turn's head has what it wrote before the cut,
 * its tail the rest. Words it can't place in time (from before their times were kept, an answer
 * in other words) are the tail's.
 */
export function wordsOf(card: Pick<AgentItem, 'text' | 'textMarks'>, part: TurnPart | undefined): string {
  if (!part) return card.text;
  if (part.side === 'live') return '';
  const marks = card.textMarks;
  const placed = marks !== undefined && marks.at(-1)?.end === card.text.length;
  const end = placed ? (marks.filter((m) => m.at <= part.cut).at(-1)?.end ?? 0) : 0;
  return part.side === 'head' ? card.text.slice(0, end).trimEnd() : card.text.slice(end).replace(/^\n+/, '');
}

/**
 * The working line at the bottom of a turn Claude is on: what it's doing in a few words, or ''
 * while a step runs (the step's own row, just above, says which). Undefined: no working line
 * (waiting for an approval, or not working).
 */
export function workingPhase(card: AgentItem): string | undefined {
  if (!isLiveTurn(card) || card.status === 'awaiting_approval') return undefined;
  // Answered, but its run waits on work it left going in the background.
  const waiting = backgroundWait([card]);
  if (waiting) return waiting;
  if (card.between === 'writing' || (card.text && !card.between)) return 'Writing';
  if (card.between === 'thinking') return 'Thinking';
  if (card.steps.some((x) => !HIDDEN_STEPS.test(x))) return '';
  const subs = card.subagents.filter((x) => x.status === 'running').length;
  // Before its first step: what it waits on, when it says (Claude Code downloading, an API retry; BLG-403).
  return subs ? `${subs} sub-agent${subs === 1 ? '' : 's'} at work` : (card.progress ?? 'Starting');
}
