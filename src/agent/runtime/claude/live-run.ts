import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StepRecord } from '../../../shared/steps.js';
import type { AgentRunInput } from '../../types.js';

/** Task types that are Claude working (not a background shell or a watcher). */
const AGENT_TASKS = new Set(['local_agent', 'local_workflow', 'remote_agent']);
const FINISHED = new Set(['completed', 'failed', 'killed', 'stopped']);

/**
 * The prompts of one live Claude Code session: the first request, then follow-ups sent while
 * its background agents are still working. Ending it lets Claude Code exit.
 */
/** What one prompt carries: plain text, or text plus content blocks (pasted images). */
export type PromptContent = SDKUserMessage['message']['content'];

export class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: Array<{ content: PromptContent | Promise<PromptContent>; uuid: SDKUserMessage['uuid']; priority?: 'next' }> = [];
  private wake?: () => void;
  private ended = false;

  get closed(): boolean {
    return this.ended;
  }

  /**
   * Returns the prompt's id (Claude Code says which prompts each turn took in), or false once
   * closed. `steer`: sent while Claude works, it's folded into the running turn at its next step.
   * `uuid`: the id it gets in Claude's transcript (a message's request id, so an edit can cut there).
   * `content` may still be on its way (a custom command being read): it goes in, in its turn, once it's there.
   */
  push(content: PromptContent | Promise<PromptContent>, { steer = false, uuid = randomUUID() }: { steer?: boolean; uuid?: string | undefined } = {}): string | false {
    if (this.ended) return false;
    this.items.push({ content, uuid: uuid as SDKUserMessage['uuid'], ...(steer ? { priority: 'next' as const } : {}) });
    this.wake?.();
    return uuid;
  }

  /** Out of the queue before Claude Code got it (see PromptQueue.push): false once it went. */
  remove(uuid: string): boolean {
    const at = this.items.findIndex((item) => item.uuid === uuid);
    if (at === -1) return false;
    this.items.splice(at, 1);
    return true;
  }

  close(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        const content = item.content instanceof Promise ? await item.content : item.content;
        yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: item.uuid, ...(item.priority ? { priority: item.priority } : {}) };
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

interface TaskMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly task_id?: string;
  readonly task_type?: string;
  readonly status?: string;
  readonly patch?: { status?: string };
  readonly tasks?: ReadonlyArray<{ task_id: string; task_type: string; ambient?: boolean; parent_task_id?: string }>;
}

/**
 * Whether Claude still has background work running, from the SDK stream. Prefers the level
 * signal (background_tasks_changed); falls back to task_started/finished edges for agents.
 * Agents count, and so do the shells and watches they started (the agent picks their result up
 * later). A shell or watch the main conversation left running (the full tests, a build) counts
 * too, as `shells`: Claude often ends its turn waiting for it, and only an open run gets the
 * notice that it ended (else that work is cut off and nobody picks it up). The run keeps those
 * open for less long than agents (see runner.ts › SHELL_LIMIT_MS): a dev server never ends.
 */
export class BackgroundAgents {
  private live = new Set<string>();
  private shellIds = new Set<string>();

  observe(msg: TaskMessage): void {
    if (msg.type !== 'system') return;
    if (msg.subtype === 'background_tasks_changed' && msg.tasks) {
      const active = msg.tasks.filter((t) => !t.ambient);
      this.live = new Set(active.filter((t) => AGENT_TASKS.has(t.task_type) || t.parent_task_id).map((t) => t.task_id));
      this.shellIds = new Set(active.filter((t) => !AGENT_TASKS.has(t.task_type) && !t.parent_task_id).map((t) => t.task_id));
      return;
    }
    const id = msg.task_id;
    if (!id) return;
    if (msg.subtype === 'task_started' && msg.task_type && AGENT_TASKS.has(msg.task_type)) this.live.add(id);
    const status = msg.subtype === 'task_updated' ? msg.patch?.status : msg.subtype === 'task_notification' ? msg.status : undefined;
    if (status && FINISHED.has(status)) {
      this.live.delete(id);
      this.shellIds.delete(id);
    }
  }

  /** Something in the background will come back to Claude. */
  get busy(): boolean {
    return this.live.size > 0 || this.shellIds.size > 0;
  }

  /** Agents (or what they started) are working: worth the long wait. */
  get agents(): boolean {
    return this.live.size > 0;
  }
}

type OnEvent = AgentRunInput['onEvent'];

/** Where one turn's output goes: the request that started the run, or a follow-up sent into it. */
export interface TurnRoute {
  readonly onEvent: OnEvent;
  /** Steps in detail (see AgentRunInput.onStep). */
  readonly onStep?: (record: StepRecord) => void;
  readonly onDone?: (final: string) => void;
  readonly onError?: (reason: string) => void;
  /** Its own turn begins (a message steered in that Claude didn't take in mid-turn). */
  readonly onStart?: () => void;
  /** Claude took it into another turn, between two steps: that turn's answer covers it. */
  readonly onFolded?: () => void;
}

/**
 * Sends each turn of a live session to the right request. Follow-ups take the next turns in
 * the order they were sent; turns Claude starts by itself (a background agent finished)
 * belong to the original request. A message Claude Code folds into a running turn (steering)
 * gets no turn of its own: the turn's result lists it among the prompts it took in.
 */
export class TurnRouter {
  private readonly pending: Array<{ route: TurnRoute; uuid?: string; steer: boolean }> = [];
  private active: TurnRoute;
  private inTurn = true;
  /** The original request's answers, one per turn of its own. */
  readonly answers: string[] = [];

  constructor(private readonly original: TurnRoute) {
    this.active = original;
  }

  /** The route for a main-thread message, opening a new turn after a result. */
  current(): TurnRoute {
    if (!this.inTurn) {
      const next = this.pending.shift()?.route;
      this.active = next ?? this.original;
      this.inTurn = true;
      next?.onStart?.();
    }
    return this.active;
  }

  /**
   * A turn ended. Returns false when the original request's own turn failed. `took`: the ids
   * of the prompts the turn took in (Claude Code's user_message_uuids); undefined from a Claude
   * Code too old to say, when steered messages are taken as folded in (they were sent to be).
   */
  end(ok: boolean, text: string, took?: readonly string[]): boolean {
    const route = this.current();
    this.inTurn = false;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (took ? p.uuid !== undefined && took.includes(p.uuid) : p.steer) {
        this.pending.splice(i, 1);
        p.route.onFolded?.();
      }
    }
    if (route === this.original) {
      if (ok && text) {
        this.answers.push(text);
        // The first answer is what the asker waits for, even if background agents keep the run open.
        if (this.answers.length === 1) this.original.onDone?.(text);
      }
      return ok;
    }
    if (ok) route.onDone?.(text);
    else route.onError?.(text || 'Claude stopped before answering');
    return true;
  }

  /**
   * Mid-turn, Claude Code says which prompts the turn has taken in so far (an assistant frame's
   * user_message_uuids): messages waiting among them are read now, not when the turn ends (a
   * turn kept going by background work can run for an hour). Send now's message stays its own.
   */
  read(took: readonly string[]): void {
    if (!this.inTurn) return;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (p.uuid === undefined || !p.steer || !took.includes(p.uuid)) continue;
      this.pending.splice(i, 1);
      p.route.onFolded?.();
    }
  }

  /**
   * A steered message to be answered in a turn of its own (Send now): never taken as folded into
   * the turn it was sent during unless that turn says it took it. False: not waiting any more.
   */
  unsteer(uuid: string): boolean {
    const p = this.pending.find((x) => x.uuid === uuid);
    if (!p) return false;
    p.steer = false;
    return true;
  }

  /** Back to being folded in at Claude's next step (Send now couldn't interrupt). */
  resteer(uuid: string): void {
    const p = this.pending.find((x) => x.uuid === uuid);
    if (p) p.steer = true;
  }

  /** Out of line, unanswered (it's sent again under a new id). False: not waiting any more. */
  drop(uuid: string): boolean {
    const at = this.pending.findIndex((x) => x.uuid === uuid);
    if (at === -1) return false;
    this.pending.splice(at, 1);
    return true;
  }

  /** `uuid`: the prompt's id (see PromptQueue.push); `steer`: sent while Claude works, to be folded in. */
  queue(route: TurnRoute, uuid?: string, steer = false): void {
    this.pending.push({ route, ...(uuid ? { uuid } : {}), steer });
  }

  /** Follow-ups sent but not answered yet. */
  get waiting(): boolean {
    return this.pending.length > 0 || (this.inTurn && this.active !== this.original);
  }

  /** Between turns: Claude has answered and isn't working on a new turn. */
  get between(): boolean {
    return !this.inTurn;
  }

  failPending(reason: string): void {
    const open = [...(this.inTurn && this.active !== this.original ? [this.active] : []), ...this.pending.splice(0).map((p) => p.route)];
    for (const route of open) route.onError?.(reason);
  }
}
