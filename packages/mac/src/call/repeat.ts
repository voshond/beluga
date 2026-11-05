/**
 * A call's own timers (BLG-706): the heartbeat, voice levels, the ringtone's schedule. Unlike the
 * screen's clocks (lib/window-active useClock), these must not rest while you look away: the call
 * goes on with Beluga behind other apps. Each one stops with the call. Returns a stop.
 */
export function repeat(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const next = (): void => {
    timer = setTimeout(() => {
      if (stopped) return;
      fn();
      next();
    }, ms);
  };
  next();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
