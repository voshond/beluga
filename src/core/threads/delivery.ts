import { randomUUID } from 'node:crypto';
import type { ThreadRecord } from '../../shared/threads.js';
import { TERMINAL_DRIVING } from '../agent-host.js';
import type { Action } from '../store.js';
import { type ThreadNode, type ThreadResult, isReportable, threadBatchLine, threadBatchPrompt } from './model.js';

/**
 * Brings results to the parent: once, in one batch, also across a restart. A result waits on the
 * child's record until it is marked delivered. The mark is saved before the run, as the gateway
 * does: a crash between the two loses a wake, and never repeats one.
 */

/** How long a result waits for its siblings before the parent wakes. */
export const WAKE_MS = 2000;

/** Where a parent stands: `held` keeps its reports until it can take them, `gone` keeps them on the child for good. */
export type ParentPlace = 'here' | 'held' | 'gone';

export interface ThreadDeliveryDeps {
  readonly selfId: () => string;
  readonly nodes: () => readonly ThreadNode[];
  readonly place: (parent: string) => ParentPlace;
  /** A turn works in this chat, or waits in its queue. */
  readonly busy: (parent: string) => boolean;
  readonly describe: (node: ThreadNode) => Pick<ThreadResult, 'title' | 'agent'>;
  readonly setThread: (id: string, thread: ThreadRecord) => void;
  /** A wake of a parent that is a thread itself: its answer is owed up the chain, as any agent-started turn. */
  readonly owe: (parent: string, requestId: string) => void;
  readonly wake: (parent: string, prompt: string, line: string, requestId: string) => void;
  readonly wakeMs?: number;
}

export class ThreadDelivery {
  /** Parents with a batch timer running. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Parents that could not take their reports: tried again at their next final event or restore. */
  private readonly held = new Set<string>();
  /** Wakes on their way, and the results each carries. A wake that a terminal refuses gives them back. */
  private readonly carrying = new Map<string, { readonly parent: string; readonly ids: readonly string[] }>();
  private stopped = false;

  constructor(private readonly deps: ThreadDeliveryDeps) {}

  /** A child saved a result. Its siblings get a moment to join it. */
  resultSaved(parent: string): void {
    if (this.stopped || this.timers.has(parent)) return;
    const timer = setTimeout(() => {
      this.timers.delete(parent);
      this.flush(parent);
    }, this.deps.wakeMs ?? WAKE_MS);
    timer.unref?.();
    this.timers.set(parent, timer);
  }

  /** A held parent's turn ended or its terminal closed, or the workspaces changed (a restore). */
  onAction(action: Action): void {
    if (action.type === 'agent_event' && isFinalEvent(action.event)) this.wakeEnded(action.requestId, action.text);
    if (!this.held.size) return;
    if (action.type === 'agent_term' && !action.state && this.held.has(`ws:${action.id}`)) this.flush(`ws:${action.id}`);
    if (action.type === 'projects') for (const parent of [...this.held]) this.flush(parent);
    if (action.type === 'agent_event' && action.owner === this.deps.selfId() && action.channel && this.held.has(action.channel) && isFinalEvent(action.event)) this.flush(action.channel);
  }

  /** Every parent with a result still on its way (after a restart). */
  recover(): void {
    const parents = new Set(this.deps.nodes().filter((n) => isReportable(n.thread)).map((n) => n.thread.parent));
    for (const parent of parents) this.resultSaved(parent);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.held.clear();
    this.carrying.clear();
  }

  private flush(parent: string): void {
    if (this.stopped) return;
    const place = this.deps.place(parent);
    if (place === 'gone') return void this.held.delete(parent);
    if (place === 'held' || this.deps.busy(parent)) return void this.held.add(parent);
    this.held.delete(parent);
    const due = this.deps.nodes().filter((n) => n.thread.parent === parent && isReportable(n.thread));
    if (!due.length) return;
    const results = due.map((n): ThreadResult => ({ id: n.id, ...this.deps.describe(n), state: n.thread.outcome!.state, summary: n.thread.outcome!.summary }));
    for (const n of due) this.deps.setThread(n.id, { ...n.thread, outcome: { ...n.thread.outcome!, delivered: true } });
    const requestId = randomUUID();
    this.carrying.set(requestId, { parent, ids: due.map((n) => n.id) });
    this.deps.owe(parent, requestId);
    this.deps.wake(parent, threadBatchPrompt(results), threadBatchLine(results), requestId);
  }

  /** A terminal opened while the wake waited in the queue, so no run read the results: they wait again. */
  private wakeEnded(requestId: string, text: string): void {
    const wake = this.carrying.get(requestId);
    if (!wake) return;
    this.carrying.delete(requestId);
    if (text !== TERMINAL_DRIVING) return;
    for (const n of this.deps.nodes()) if (wake.ids.includes(n.id) && n.thread.outcome) this.deps.setThread(n.id, { ...n.thread, outcome: { ...n.thread.outcome, delivered: false } });
    this.held.add(wake.parent);
  }
}

const isFinalEvent = (event: string): boolean => event === 'done' || event === 'error' || event === 'denied';
