import { randomUUID } from 'node:crypto';
import type { AgentBackend } from '../agent/types.js';
import type { Btw, Store } from './store.js';

/** How often a streaming answer reaches the screens (each update goes to every one). */
const FLUSH_MS = 80;

/** Where a conversation's Claude works, for a side question about it. */
export interface BtwPlace {
  readonly cwd: string;
  /** Its agent's session, once it has one. */
  readonly resume?: string;
  readonly model?: string;
  /** The agent it runs on, when it picked its own (else your default's). */
  readonly runtime?: string;
}

export interface BtwDeps {
  readonly store: Store;
  readonly agent: () => AgentBackend | undefined;
  readonly place: (channel: string) => BtwPlace | undefined;
}

/**
 * Side questions (/btw): ask about a conversation while its Claude keeps working. The answer comes
 * from a fork of the conversation's session (it knows everything said there), with no tools, and
 * is shown beside the chat: it never joins the conversation, its queue or Claude's memory of it.
 * One per conversation: asking another replaces it.
 */
export class BtwDesk {
  private readonly live = new Map<string, { id: string; controller: AbortController }>();

  constructor(private readonly deps: BtwDeps) {}

  /** Ask; resolves once it's answered (or failed). An error only when it can't be asked here. */
  async ask(channel: string, question: string): Promise<void> {
    const agent = this.deps.agent();
    if (!agent?.btw) throw new Error('No agent is running on this computer');
    const place = this.deps.place(channel);
    if (!place) throw new Error('Side questions work in a worktree or project conversation');
    const text = question.trim();
    if (!text) throw new Error('Ask something');
    this.live.get(channel)?.controller.abort();
    const id = `btw-${randomUUID()}`;
    const controller = new AbortController();
    this.live.set(channel, { id, controller });
    const mine = (): boolean => this.live.get(channel)?.id === id;
    let btw: Btw = { id, question: text, text: '', state: 'thinking', at: Date.now() };
    const put = (next: Partial<Btw>): void => {
      btw = { ...btw, ...next };
      if (mine()) this.deps.store.dispatch({ type: 'btw', channel, btw });
    };
    put({});
    let pending: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      timer = undefined;
      if (pending !== undefined) put({ text: pending, state: 'answering' });
      pending = undefined;
    };
    try {
      const answer = await agent.btw({
        question: text,
        cwd: place.cwd,
        ...(place.resume ? { resume: place.resume } : {}),
        ...(place.model ? { model: place.model } : {}),
        ...(place.runtime ? { runtime: place.runtime } : {}),
        signal: controller.signal,
        onText: (soFar) => {
          pending = soFar;
          timer ??= setTimeout(flush, FLUSH_MS);
        },
      });
      if (timer) clearTimeout(timer);
      const said = answer.trim() || (pending ?? btw.text).trim();
      // Nothing to show is a failure, never a blank card that looks like nothing happened (BLG-729).
      put(said ? { text: said, state: 'done' } : { text: '', state: 'failed', error: 'The answer came back empty' });
    } catch (err) {
      if (timer) clearTimeout(timer);
      // Closed or replaced: nothing to say.
      if (controller.signal.aborted && !mine()) return;
      put({ text: pending ?? btw.text, state: 'failed', error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (mine()) this.live.delete(channel);
    }
  }

  /** Close a conversation's side question (stopping Claude if it's still answering). */
  dismiss(channel: string): void {
    const live = this.live.get(channel);
    this.live.delete(channel);
    live?.controller.abort();
    if (this.deps.store.getState().btw?.[channel]) this.deps.store.dispatch({ type: 'btw', channel });
  }
}
