/**
 * How the link to a computer is doing, as a screen of yours there feels it (BLG-792): its round
 * trip, measured by the screen's own pings through the door, or how long one has waited unanswered.
 * Slower than about 300 ms says Slow on the computer's tag; a ping unanswered for a few seconds, or
 * no screen at all, says the link is lost (what's kept on this Mac still shows). Browser-safe.
 */

/** A round trip slower than this is said. */
export const SLOW_LINK_MS = 300;
/** A ping unanswered this long: the link is lost. */
export const LOST_LINK_MS = 4_000;
/** How often a screen pings its computer. */
export const PING_EVERY_MS = 2_000;

export type LinkState = 'ok' | 'slow' | 'lost';

export interface LinkSample {
  /** A screen is open there. */
  readonly connected: boolean;
  /** The last ping's round trip. */
  readonly rttMs?: number;
  /** How long the ping in flight has waited. */
  readonly waitingMs?: number;
}

export interface LinkHealth {
  readonly state: LinkState;
  readonly rttMs?: number;
  /** In words, for the tag's tip. */
  readonly words: string;
}

export function linkHealth(s: LinkSample, name = 'This computer'): LinkHealth {
  if (!s.connected || (s.waitingMs ?? 0) >= LOST_LINK_MS) return { state: 'lost', words: `${name} can’t be reached right now. What you saw last still shows; Beluga keeps trying.` };
  // A ping waiting longer than a slow round trip is a slow link already.
  const rtt = Math.max(s.rttMs ?? 0, s.waitingMs ?? 0);
  if (rtt > SLOW_LINK_MS) return { state: 'slow', rttMs: rtt, words: `The link to ${name} is slow (${Math.round(rtt)} ms). Typing stays here; what you send arrives a moment later.` };
  return { state: 'ok', ...(s.rttMs !== undefined ? { rttMs: s.rttMs } : {}), words: s.rttMs !== undefined ? `Runs on ${name} (${Math.round(s.rttMs)} ms)` : `Runs on ${name}` };
}
