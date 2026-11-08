import type { RunFailure } from './run-failure.js';

/**
 * Continuing on its own after a usage limit (BLG-757). A run of your agent's that stopped on your
 * plan's usage limit is told "Continue where you left off." once the limit resets: on by default,
 * in every agent conversation (worktrees, project chats, Your Mac's chats, the Sentinel chat), never
 * in a chat between people (the room, DMs, groups) or a sentinel's run (it runs again itself). The
 * limit card says when it goes, and you can turn it off for that chat, for this limit session
 * (every chat skips the resume due at that reset; the next limit continues again), or everywhere
 * (Settings). The daemon sends it
 * (core/auto-continue.ts; plans resume their own, core/plans/watchdog.ts); the screens read these
 * same rules to say when. Browser-safe.
 */

/** Resuming a moment after the reset, so the first message isn't refused again. */
export const LIMIT_MARGIN_MS = 60_000;
/** A usage limit with no known reset: tried again this long after it stopped. */
export const LIMIT_UNKNOWN_MS = 30 * 60_000;
/** A resume this late (Beluga wasn't running when it was due) isn't sent on its own any more: Continue is yours. */
export const AUTO_CONTINUE_LATE_MS = 6 * 60 * 60_000;
/** "Not this session" covers resumes due up to this long after the one it was said on (chats that stopped a little later). */
export const SESSION_SLACK_MS = 15 * 60_000;
/** Chats it's off in, at most (the oldest go first). */
export const AUTO_CONTINUE_OFF_MAX = 500;

/** The preferences it follows (Settings, and the limit card's choices). */
export interface AutoContinuePrefs {
  /** On everywhere (the default), or off. */
  readonly autoContinue: boolean;
  /** Chats it's off in. */
  readonly autoContinueOff: readonly string[];
  /** "Not this session": resumes due at or before this time (epoch ms) aren't sent; 0: none skipped. */
  readonly autoContinueSkip: number;
}

/** Why a limit's resume isn't sent on its own: off in Settings, in this chat, this session, too late, a chat between people, or a sentinel's run (it runs again itself). */
export type AutoContinueOff = 'everywhere' | 'chat' | 'session' | 'late' | 'people' | 'sentinel';

export type AutoContinueState = { readonly kind: 'scheduled'; readonly at: number } | { readonly kind: 'off'; readonly why: AutoContinueOff; readonly at: number };

/** Agent conversations: worktrees and project chats (`ws:`), Your Mac's chats (`mac:`) and the Sentinel chat's (`sentinel-chat:`). The room, DMs and groups are people's. */
export const autoContinues = (channel: string): boolean => channel.startsWith('ws:') || channel.startsWith('mac:') || channel.startsWith('sentinel-chat:');

/** When a run stopped by a usage limit is sent on: a minute after the reset, or 30 minutes after it stopped when the reset isn't known. */
export const limitResumeAt = (failure: Pick<RunFailure, 'resetsAt'>, stoppedAt: number): number => (failure.resetsAt ?? stoppedAt + LIMIT_UNKNOWN_MS) + LIMIT_MARGIN_MS;

/**
 * Whether a limit's resume due `at` in `channel` goes on its own. `now` given: one already this
 * late doesn't (left out: plans resume whenever Beluga gets to it).
 */
export function autoContinueFor(prefs: AutoContinuePrefs, channel: string, at: number, now?: number): AutoContinueState {
  const off = (why: AutoContinueOff): AutoContinueState => ({ kind: 'off', why, at });
  if (!autoContinues(channel)) return off('people');
  if (!prefs.autoContinue) return off('everywhere');
  if (prefs.autoContinueOff.includes(channel)) return off('chat');
  if (prefs.autoContinueSkip > 0 && at <= prefs.autoContinueSkip) return off('session');
  if (now !== undefined && now > at + AUTO_CONTINUE_LATE_MS) return off('late');
  return { kind: 'scheduled', at };
}

/** The skip "Not this session" sets, said on a resume due `at`. */
export const sessionSkip = (at: number): number => at + SESSION_SLACK_MS;

/** The chats it's off in, with `channel` turned off (`off`) or back on: newest last, at most AUTO_CONTINUE_OFF_MAX. */
export function chatsOff(list: readonly string[], channel: string, off: boolean): string[] {
  const rest = list.filter((c) => c !== channel);
  return off ? [...rest, channel].slice(-AUTO_CONTINUE_OFF_MAX) : rest;
}
