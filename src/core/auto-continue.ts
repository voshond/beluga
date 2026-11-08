import { hhmm } from '../shared/clock.js';
import { autoContinueFor, autoContinues, limitResumeAt } from '../shared/auto-continue.js';
import { CONTINUE_PROMPT, decodeFailure } from '../shared/run-failure.js';
import { planOfChannel } from './notify.js';
import { isSentinelChat, sentinelOfChannel } from './sentinel/model.js';
import { type DomainState, type LogItem, type Store, isRunning } from './store.js';

/** How often it looks for a limit that has reset (the resume goes within this of its time). */
export const AUTO_CONTINUE_TICK_MS = 15_000;

type AgentCard = Extract<LogItem, { type: 'agent' }>;

/** A conversation whose agent stopped on your usage limit, and nothing ran there since. */
export interface LimitStop {
  readonly channel: string;
  /** The stopped run's card (its log id) and request. */
  readonly id: string;
  readonly requestId: string;
  /** When it's sent on (shared/auto-continue.ts limitResumeAt). */
  readonly at: number;
  /** The limit said when it resets (not a guess). */
  readonly known: boolean;
}

/**
 * Agent conversations whose newest run is one of yours that stopped on your usage limit, with
 * nothing queued or running behind it. Chats between people aren't looked at.
 */
export function limitStops(log: readonly LogItem[], selfId: string): LimitStop[] {
  const last = new Map<string, AgentCard>();
  const busy = new Set<string>();
  for (const item of log) {
    if (item.type !== 'agent' || !autoContinues(item.channel)) continue;
    last.set(item.channel, item);
    if (isRunning(item.status)) busy.add(item.channel);
  }
  const out: LimitStop[] = [];
  for (const [channel, card] of last) {
    if (busy.has(channel) || card.status !== 'error' || card.owner !== selfId) continue;
    const failure = decodeFailure(card.text);
    if (failure?.kind !== 'usage_limit') continue;
    out.push({ channel, id: card.id, requestId: card.requestId, at: limitResumeAt(failure, card.endTs ?? card.lastAt ?? card.ts), known: failure.resetsAt !== undefined });
  }
  return out;
}

/**
 * A sentinel's run made this conversation: the sentinel runs again once the limit resets (docs/sentinel.md),
 * so its failed run's chat isn't continued as well. The chat where you change a sentinel with your agent is.
 */
export const sentinelRunChat = (state: Pick<DomainState, 'sentinel'>, channel: string): boolean => Boolean(sentinelOfChannel(state.sentinel, channel)?.runId);

/** When the stopped run in `channel` is told to continue on its own, if it is (what the screens say on its card). */
export function resumeOf(state: DomainState, channel: string, now: number): { readonly id: string; readonly at: number } | undefined {
  const stop = limitStops(state.log.filter((l) => l.channel === channel), state.selfId)[0];
  return stop && now < stop.at && !sentinelRunChat(state, channel) && autoContinueFor(state.prefs, channel, stop.at, now).kind === 'scheduled' ? { id: stop.id, at: stop.at } : undefined;
}

/** Whether the conversation is still there: a worktree or project chat not archived, one of Your Mac's chats, or of the Sentinel chat's. */
function stillThere(state: DomainState, channel: string): boolean {
  if (channel.startsWith('mac:')) return state.assistant.chats.some((c) => c.channel === channel);
  if (isSentinelChat(channel)) return state.sentinel.enabled && (state.sentinel.chats?.chats ?? []).some((c) => c.channel === channel);
  const id = channel.slice(3);
  return state.projects.some((p) => p.workspaces.some((w) => w.id === id && !w.archived));
}

export interface AutoContinueDeps {
  readonly store: Store;
  /** Your agent, told to go on in `channel` (urgent: ahead of what queued behind the stopped turn). Its request's id; undefined: it couldn't be asked there. */
  readonly ask: (prompt: string, channel: string) => string | undefined;
  readonly now?: () => number;
  readonly warn?: (text: string) => void;
  /** A chat not to send on (a child thread that a stop reached, core/threads). */
  readonly skip?: (channel: string) => boolean;
  /** It sent on `channel` under `requestId` (a child thread owes that turn to its parent). */
  readonly sent?: (channel: string, requestId: string) => void;
}

/**
 * Sends "Continue where you left off." into each agent conversation that stopped on your usage
 * limit, once it has reset (shared/auto-continue.ts says when, and when not). A plan running in a
 * conversation resumes it its own way (core/plans/watchdog.ts), and a sentinel's run runs again, so
 * those are left to them. Each stopped run is sent on once, and a conversation it sent on that stops
 * on the limit again is sent on again only at a reset the limit names, later than the last send: a
 * guessed reset (a plain rate limit, a used-up key) or one already past would make it a loop.
 */
export class AutoContinue {
  private readonly sent = new Set<string>();
  /** When it last sent on each conversation. */
  private readonly sentAt = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly off: () => void;

  constructor(private readonly deps: AutoContinueDeps) {
    this.timer = setInterval(() => this.tick(), AUTO_CONTINUE_TICK_MS);
    this.timer.unref?.();
    // Turned back on (or off) from a card or Settings: looked at again in a moment (after the change is saved), not at the next tick.
    this.off = deps.store.onAction((a) => {
      if (a.type === 'prefs') setTimeout(() => this.tick(), 0).unref?.();
    });
  }

  stop(): void {
    clearInterval(this.timer);
    this.off();
  }

  /** Send on what's due. */
  tick(): void {
    try {
      this.sendDue();
    } catch (err) {
      this.deps.warn?.(`Continuing after a usage limit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sendDue(): void {
    const state = this.deps.store.getState();
    const now = this.deps.now?.() ?? Date.now();
    for (const stop of limitStops(state.log, state.selfId)) {
      if (this.sent.has(stop.requestId) || now < stop.at) continue;
      if (autoContinueFor(state.prefs, stop.channel, stop.at, now).kind !== 'scheduled') continue;
      if (!stillThere(state, stop.channel) || sentinelRunChat(state, stop.channel) || this.deps.skip?.(stop.channel)) continue;
      const plan = planOfChannel(state, stop.channel)?.plan;
      if (plan?.status === 'active') continue;
      const last = this.sentAt.get(stop.channel);
      if (last !== undefined && (!stop.known || stop.at <= last)) continue;
      this.sent.add(stop.requestId);
      const requestId = this.deps.ask(CONTINUE_PROMPT, stop.channel);
      if (requestId === undefined) continue;
      this.deps.sent?.(stop.channel, requestId);
      this.sentAt.set(stop.channel, now);
      this.deps.store.dispatch({ type: 'system', channel: stop.channel, text: `Your usage limit reset: Beluga told your agent to continue at ${hhmm(now)}.`, level: 'info' });
    }
  }
}
