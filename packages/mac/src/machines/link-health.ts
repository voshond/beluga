// Relative, not @beluga: the root's tests and typecheck read this file too.
import type { SocketClient } from '../../../../src/ipc/socket-client.js';
import { LOST_LINK_MS, type LinkSample, PING_EVERY_MS } from '../../../../src/machines/links.js';

/**
 * Each computer's link as this window feels it (BLG-792): its screen pings the computer every two
 * seconds (through the door, so the round trip is the link's), and the computer's tag says when the
 * link is slow or lost. Nothing waits on it: typing and drawing go on from what's here.
 */

const samples = new Map<string, LinkSample>();
const listeners = new Set<() => void>();
const NONE: LinkSample = { connected: false };

function set(id: string, sample: LinkSample): void {
  const was = samples.get(id);
  if (was && was.connected === sample.connected && was.rttMs === sample.rttMs && was.waitingMs === sample.waitingMs) return;
  samples.set(id, sample);
  for (const l of [...listeners]) l();
}

/** Hear every computer's link change (use-link-sample.ts draws it). */
export const subscribeLinks = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** A beat: `tick` every `ms` until the returned stop (the window's everyWhileShown, so it rests while nobody looks). */
export type Beat = (tick: () => void, ms: number) => () => void;

/** Ping computer `id` through its screen on `beat` until the returned stop; then it's said lost (the screen went). */
export function watchLink(id: string, client: Pick<SocketClient, 'ping'>, beat: Beat, everyMs = PING_EVERY_MS): () => void {
  let sentAt: number | undefined;
  let rttMs: number | undefined;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    if (sentAt !== undefined) {
      // Still waiting: past a slow round trip it shows, past LOST_LINK_MS the link is lost.
      set(id, { connected: true, ...(rttMs !== undefined ? { rttMs } : {}), waitingMs: Date.now() - sentAt });
      if (Date.now() - sentAt < LOST_LINK_MS) return;
    }
    const mine = Date.now();
    sentAt = mine;
    void client.ping().then((ms) => {
      if (stopped || sentAt !== mine) return;
      sentAt = undefined;
      rttMs = ms;
      set(id, { connected: true, rttMs: ms });
    });
  };
  set(id, { connected: true });
  tick();
  const stop = beat(tick, Math.min(everyMs, 1_000));
  return () => {
    stopped = true;
    stop();
    set(id, NONE);
  };
}

/** Computer `id`'s link now: undefined until a screen there first connects (connecting isn't lost). */
export const linkSampleOf = (id: string): LinkSample | undefined => samples.get(id);

