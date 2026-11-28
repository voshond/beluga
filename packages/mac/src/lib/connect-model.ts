/**
 * What the window says before it is attached to Beluga. Starting takes a while (the engine reads
 * your projects, and a busy computer makes it slower), and an attempt that fails or times out
 * while it starts is normal: the window keeps trying. So waiting reads as waiting, and the words
 * for a problem ("taking longer than usual", the reason, Try again) come only once it really has
 * taken long.
 */

/** Waiting this long is still an ordinary start: nothing reads as a problem before it. */
export const STARTING_GRACE_MS = 60_000;

/** After this long, one calm line says it's still coming. */
export const STARTING_LINGERS_MS = 10_000;

/**
 * `starting`: the first attach after the window opened. `reconnecting`: Beluga was here and went
 * away (it restarted). `slow`: it has taken too long, and an attempt failed: say so, with why.
 */
export type ConnectView = 'starting' | 'reconnecting' | 'slow';

export interface Connecting {
  /** The last attempt failed (or got no answer in time); another one is on its way. */
  readonly failed: boolean;
  /** Since the window began trying: when it opened, or when Beluga went away. */
  readonly waitedMs: number;
  /** This window was attached before. */
  readonly wasConnected: boolean;
}

export function connectViewOf({ failed, waitedMs, wasConnected }: Connecting): ConnectView {
  if (failed && waitedMs >= STARTING_GRACE_MS) return 'slow';
  return wasConnected ? 'reconnecting' : 'starting';
}

/** The headline for each. */
export function connectTitle(view: ConnectView, wasConnected: boolean): string {
  if (view === 'starting') return 'Starting Beluga…';
  if (view === 'reconnecting') return 'Reconnecting to Beluga…';
  return wasConnected ? 'Beluga is taking longer than usual to come back' : 'Beluga is taking longer than usual to start';
}

/** A calm second line once the wait is noticeable (never a reason, never a button). */
export function connectNote(view: ConnectView, waitedMs: number): string | undefined {
  if (view === 'slow') return 'Still trying. If it stays like this, quit Beluga and open it again.';
  return waitedMs >= STARTING_LINGERS_MS ? 'This can take a little while, longer when your computer is busy.' : undefined;
}
