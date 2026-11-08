/**
 * A thread: a chat that another agent started through the thread tools (core/threads). The child is
 * a normal workspace chat with this record on it; its harness and model stay in WorkspaceRecord.agent
 * and WorkspaceRecord.model. Browser-safe: types and defaults only.
 */

export type ThreadEnd = 'done' | 'failed' | 'stopped' | 'interrupted';
/** `waiting_limit`: its turn stopped on your usage limit, and Beluga's auto-continue sends it on after the reset (shared/auto-continue.ts). */
export type ThreadState = 'queued' | 'running' | 'needs_you' | 'waiting_limit' | ThreadEnd;

/** The states where a thread's turn has ended (a status wait ends on these, and on needs_you). */
export const THREAD_ENDS: readonly ThreadEnd[] = ['done', 'failed', 'stopped', 'interrupted'];

/** A thread's state in words, on both screens. */
export const THREAD_WORDS: Readonly<Record<ThreadState, string>> = { queued: 'Queued', running: 'Running', needs_you: 'Needs you', waiting_limit: 'Waiting for limit', done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted' };

/** A thread that is not settled: its row stays in view, whatever the cap. */
export const isThreadWorking = (state: ThreadState): boolean => state === 'queued' || state === 'running' || state === 'needs_you' || state === 'waiting_limit';

/** Needs you, then working, then finished: the order of a chat's list of threads. */
export const threadRank = (state: ThreadState): number => (state === 'needs_you' ? 0 : isThreadWorking(state) ? 1 : 2);

export interface ThreadOutcome {
  readonly state: ThreadEnd;
  readonly summary: string;
  readonly at: number;
  /** The parent has it, or was never owed it (a person's turn). False: it still has to reach the parent. */
  readonly delivered: boolean;
}

export interface ThreadRecord {
  /** The channel that started it: ws:<id>, a Your Mac chat or a plan home. */
  readonly parent: string;
  readonly parentTitle: string;
  /** The channel at the top of its tree. */
  readonly root: string;
  /** How far under the root: a root's child is 1. */
  readonly depth: number;
  readonly task: string;
  /** The request that brought the task. */
  readonly by?: string;
  readonly startedAt: number;
  /** The parent's request key: the same key returns this thread. */
  readonly key?: string;
  /** A read-only chat (thread_start where=read): questions only, whatever folder it is in. */
  readonly readOnly?: true;
  /** Requests whose results the parent is owed. A person's turn is not in it. */
  readonly owed: readonly string[];
  readonly outcome?: ThreadOutcome;
  readonly stopped?: { readonly by: 'person' | 'agent'; readonly at: number };
  /** Its owed turn stopped on your usage limit: Beluga's auto-continue sends it on at `at`. `summary`: the limit's words, the result if it does not. */
  readonly limit?: { readonly at: number; readonly summary: string };
  /** A person archived or deleted the parent and kept this thread: it stands on its own, with parentTitle as words and no link. */
  readonly parentGone?: true;
}

/** What archiving or deleting a chat does to its threads. `keep` is the default of every call. */
export type ThreadChildren = 'with' | 'keep';

export interface ThreadLimits {
  /** How deep a tree goes. */
  readonly depth: number;
  /** Threads working or queued in one tree. */
  readonly treeRunning: number;
  /** Threads in one tree that are not archived. */
  readonly treeLive: number;
  /** Threads working or queued on this Mac. */
  readonly macRunning: number;
}

export const THREAD_LIMITS_DEFAULT: ThreadLimits = { depth: 3, treeRunning: 8, treeLive: 30, macRunning: 16 };
export const THREAD_LIMITS_MAX: ThreadLimits = { depth: 8, treeRunning: 64, treeLive: 500, macRunning: 128 };

/** Where a person raises a limit. */
export const THREAD_LIMITS_WHERE = 'Settings › Agent › Thread limits';

/** The rows of that place, with the values each one offers. A refusal names the row. */
export const THREAD_LIMIT_ROWS: ReadonlyArray<{ readonly key: keyof ThreadLimits; readonly label: string; readonly detail: string; readonly presets: readonly number[] }> = [
  { key: 'depth', label: 'Levels of threads', detail: 'How deep a chat’s threads go: a thread that starts a thread is one level more.', presets: [1, 2, 3, 4, 5, 8] },
  { key: 'treeRunning', label: 'Working at once in one chat’s tree', detail: 'Threads working or queued under one chat.', presets: [4, 8, 16, 32, 64] },
  { key: 'treeLive', label: 'Kept in one chat’s tree', detail: 'Threads under one chat that are not archived.', presets: [10, 30, 100, 250, 500] },
  { key: 'macRunning', label: 'Working at once on this computer', detail: 'Threads working or queued in all your chats.', presets: [8, 16, 32, 64, 128] },
];
