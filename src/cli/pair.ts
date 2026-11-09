import type { CompanionSlice } from '../companion/protocol.js';
import type { SocketClient } from '../ipc/socket-client.js';
import { type Exit, type Io, errorText } from './io.js';
import { qrLines, qrWidth } from './qr.js';

type Companion = CompanionSlice['companion'];

/** What `beluga pair` needs from the daemon: companion.pair.* and the companion slice. */
export interface PairLink {
  start(): Promise<{ readonly link: string; readonly code: string; readonly expiresAt: number }>;
  approve(): Promise<unknown>;
  cancel(): Promise<unknown>;
  companion(): Companion;
  onChange(listener: () => void): () => void;
}

export function pairLinkOf(client: SocketClient): PairLink {
  return {
    start: () => client.call('companion.pair.start'),
    approve: () => client.call('companion.pair.approve'),
    cancel: () => client.call('companion.pair.cancel'),
    companion: () => client.store.getDomain().companion,
    onChange: (l) => client.store.subscribe(l),
  };
}

export interface PairOptions {
  /** Ask a yes/no question; resolves with what was typed. */
  readonly ask: (question: string) => Promise<string>;
  /** Ctrl+C. */
  readonly signal?: AbortSignal;
  /** A terminal: a countdown that updates in place and a painted QR code. */
  readonly tty: boolean;
  /** Its width; the QR code is left out when it doesn't fit. */
  readonly columns?: number;
  /** How long the phone may be away before it counts as gone (AWAY_GRACE_MS). */
  readonly awayGraceMs?: number;
  /** How long to wait for the phone to show up in the list once approved. */
  readonly pairedWaitMs?: number;
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

type Event = { kind: 'waiting'; name: string; fingerprint: string } | { kind: 'closed' } | { kind: 'aborted' };

/** The next thing that happens to the pairing: a phone dials in, it closes (expired), or Ctrl+C. */
function next(link: PairLink, signal: AbortSignal | undefined, tick?: () => void): Promise<Event> {
  return new Promise((resolve) => {
    const check = (): boolean => {
      if (signal?.aborted) return done({ kind: 'aborted' });
      const p = link.companion().pairing;
      if (!p) return done({ kind: 'closed' });
      if (p.waiting) return done({ kind: 'waiting', ...p.waiting });
      return false;
    };
    const timer = tick ? setInterval(tick, 1000) : undefined;
    const off = link.onChange(() => void check());
    const onAbort = (): boolean => check();
    signal?.addEventListener('abort', onAbort, { once: true });
    function done(e: Event): true {
      clearInterval(timer);
      off();
      signal?.removeEventListener('abort', onAbort);
      resolve(e);
      return true;
    }
    check();
  });
}

const GONE = Symbol('gone');
const ABORTED = Symbol('aborted');

/**
 * How long the phone may be away from the pairing before it counts as gone: its link can drop
 * and come back (it retries with the same keys, or another way wins), BLG-674.
 */
export const AWAY_GRACE_MS = 5_000;

/**
 * While Pair? is asked: resolves if the phone is gone (the pairing closed, or nobody has waited
 * for AWAY_GRACE_MS) or on Ctrl+C. A phone that comes back with other pictures has them said.
 */
function stillWaiting(link: PairLink, signal: AbortSignal | undefined, shown: string, said: (w: Waiting) => void, graceMs: number): { gone: Promise<typeof GONE | typeof ABORTED>; stop: () => void } {
  let stop = (): void => undefined;
  const gone = new Promise<typeof GONE | typeof ABORTED>((resolve) => {
    let fingerprint = shown;
    let away: NodeJS.Timeout | undefined;
    const finish = (why?: typeof GONE | typeof ABORTED): void => {
      clearTimeout(away);
      off();
      signal?.removeEventListener('abort', onAbort);
      if (why) resolve(why);
    };
    stop = () => finish();
    const onAbort = (): void => finish(ABORTED);
    const check = (): void => {
      const p = link.companion().pairing;
      if (!p) return finish(GONE);
      if (!p.waiting) {
        away ??= setTimeout(() => finish(GONE), graceMs);
        return;
      }
      clearTimeout(away);
      away = undefined;
      if (p.waiting.fingerprint !== fingerprint) {
        fingerprint = p.waiting.fingerprint;
        said(p.waiting);
      }
    };
    const off = link.onChange(check);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) finish(ABORTED);
  });
  return { gone, stop };
}

type Waiting = { readonly name: string; readonly fingerprint: string };

/** A phone waiting now, or one that comes back within the grace (its link dropping for a moment). */
function waitingSoon(link: PairLink, ms: number): Promise<Waiting | undefined> {
  return new Promise((resolve) => {
    const now = (): Waiting | undefined | null => {
      const p = link.companion().pairing;
      return !p ? null : p.waiting;
    };
    const first = now();
    if (first !== undefined) return resolve(first ?? undefined);
    const timer = setTimeout(() => (off(), resolve(undefined)), ms);
    const off = link.onChange(() => {
      const w = now();
      if (w === undefined) return;
      clearTimeout(timer);
      off();
      resolve(w ?? undefined);
    });
  });
}

/** Resolves when a phone not in `before` is paired, or undefined after `ms`. */
function newPhone(link: PairLink, before: ReadonlySet<string>, ms: number): Promise<Companion['devices'][number] | undefined> {
  return new Promise((resolve) => {
    const find = (): Companion['devices'][number] | undefined => link.companion().devices.find((d) => !before.has(d.id));
    const found = find();
    if (found) return resolve(found);
    const timer = setTimeout(() => (off(), resolve(undefined)), ms);
    const off = link.onChange(() => {
      const d = find();
      if (!d) return;
      clearTimeout(timer);
      off();
      resolve(d);
    });
  });
}

/** What the screen shows first: the QR code (when it fits), the typed code and how long both last. */
function intro(info: { link: string; code: string }, opts: PairOptions): string {
  const qr = qrLines(info.link, { color: opts.tty });
  const fits = qrWidth(qr) <= (opts.columns ?? 80);
  return [
    'Pair your phone with this computer.',
    'On the phone, open Beluga and tap Scan the code:',
    '',
    ...(fits ? qr : ['  (The window is too narrow for the QR code: type the code below instead.)']),
    '',
    `Or type this code on the phone: ${info.code}`,
    '',
  ].join('\n');
}

/**
 * `beluga pair`: the QR code and the typed code, the phone's name and four pictures to compare,
 * then Pair? [y/N]. Ctrl+C or no closes the pairing (the phone is told no).
 */
export async function pair(link: PairLink, io: Io, opts: PairOptions): Promise<Exit> {
  const before = new Set(link.companion().devices.map((d) => d.id));
  const info = await link.start();
  io.out(`${intro(info, opts)}\n`);
  const left = (): string => `Waiting for your phone… the code works for ${mmss(info.expiresAt - Date.now())} more. Ctrl+C stops.`;
  // A countdown in place on a terminal; said once elsewhere.
  io.err(opts.tty ? left() : `${left()}\n`);
  const tick = opts.tty ? () => io.err(`\r\x1b[K${left()}`) : undefined;
  const event = await next(link, opts.signal, tick);
  if (opts.tty) io.err('\r\x1b[K');
  if (event.kind === 'aborted') {
    await link.cancel().catch(() => undefined);
    io.err('Pairing cancelled. Nothing was paired.\n');
    return 130;
  }
  if (event.kind === 'closed') {
    io.err('The pairing code expired before a phone used it. Run `beluga pair` again for a new one.\n');
    return 1;
  }
  io.out(`“${event.name}” wants to pair.\nCheck that the phone shows these same four pictures: ${event.fingerprint}\n`);
  const grace = opts.awayGraceMs ?? AWAY_GRACE_MS;
  const watch = stillWaiting(link, opts.signal, event.fingerprint, (w) => io.out(`\nThe phone connected again, with new pictures: check that “${w.name}” shows ${w.fingerprint}\nPair? [y/N] `), grace);
  // A question that ends without an answer (Ctrl+C) is a no, said as Ctrl+C: the phone is told no.
  const said: string | typeof GONE | typeof ABORTED = await Promise.race([opts.ask('Pair? [y/N] ').catch((): typeof ABORTED => ABORTED), watch.gone]);
  watch.stop();
  if (said === GONE) {
    // Closed cleanly, so the next `beluga pair` starts from nothing.
    await link.cancel().catch(() => undefined);
    io.err('\nThe phone stopped waiting (or the code expired). Run `beluga pair` again.\n');
    return 1;
  }
  if (typeof said !== 'string' || !/^y(es)?$/i.test(said.trim())) {
    await link.cancel().catch(() => undefined);
    io.err(said === ABORTED ? '\nPairing cancelled. Nothing was paired.\n' : 'Not paired: the phone is told no.\n');
    return said === ABORTED ? 130 : 1;
  }
  // Yes, while the phone's link is between two tries: pair it once it's back.
  if (!(await waitingSoon(link, grace))) {
    await link.cancel().catch(() => undefined);
    io.err('The phone stopped waiting (or the code expired). Run `beluga pair` again.\n');
    return 1;
  }
  try {
    await link.approve();
  } catch (err) {
    io.err(`Couldn't pair: ${errorText(err)}. Run \`beluga pair\` again.\n`);
    return 1;
  }
  const phone = await newPhone(link, before, opts.pairedWaitMs ?? 30_000);
  if (!phone) {
    io.err('The phone was approved but never finished pairing. Run `beluga pair` again.\n');
    return 1;
  }
  const relay = link.companion().relay;
  const how = relay === 'off' ? 'It reaches this computer when a direct link works (the relay is off).' : 'It reaches this computer directly, or through the relay when it can’t.';
  io.out(`Paired with ${phone.name}. ${how}\nSee your phones with \`beluga phones\`.\n`);
  return 0;
}

// ---- a computer (BLG-774)

type ComputerPairingInfo = { readonly link: string; readonly code: string; readonly expiresAt: number; readonly waiting?: { readonly name: string; readonly fingerprint: string } };
type ComputerPairingStatus = { readonly open?: ComputerPairingInfo; readonly last?: { readonly kind: 'joined' | 'declined' | 'expired' | 'cancelled'; readonly app?: string } };

/** What `beluga pair --computer` needs from the daemon: machines.pair.*. */
export interface ComputerPairLink {
  start(): Promise<ComputerPairingInfo>;
  status(): Promise<ComputerPairingStatus>;
  cancel(): Promise<unknown>;
}

export const computerPairLinkOf = (client: SocketClient): ComputerPairLink => ({
  start: () => client.call('machines.pair.start'),
  status: () => client.call('machines.pair.status'),
  cancel: () => client.call('machines.pair.cancel'),
});

export interface ComputerPairOptions {
  readonly signal?: AbortSignal;
  readonly tty: boolean;
  readonly columns?: number;
  /** One JSON line for each step (the link and code, then how it ended): what an SSH pairing reads. */
  readonly json?: boolean;
  /** How often the pairing is looked at. */
  readonly pollMs?: number;
}

const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });

/**
 * `beluga pair --computer`, on the computer: a link, a code and a QR for your Beluga app, valid
 * once for 10 minutes. When the app finds it, the four pictures it shows are printed here to
 * compare; you click Join in the app, and this computer is one of your devices.
 */
export async function pairComputer(link: ComputerPairLink, io: Io, opts: ComputerPairOptions): Promise<Exit> {
  const info = await link.start();
  if (opts.json) io.out(`${JSON.stringify({ link: info.link, code: info.code, expiresAt: info.expiresAt })}\n`);
  else {
    const qr = qrLines(info.link, { color: opts.tty });
    const fits = qrWidth(qr) <= (opts.columns ?? 80);
    io.out(
      [
        'Add this computer to your devices.',
        'In the Beluga app, open Settings › Your Computers › Add a Computer, and paste this link:',
        '',
        `  ${info.link}`,
        '',
        ...(fits ? ['Or scan it:', '', ...qr, ''] : []),
        `Or type this code: ${info.code}`,
        `It works once, for ${mmss(info.expiresAt - Date.now())}. Ctrl+C stops.`,
        '',
      ].join('\n'),
    );
  }
  let shown = '';
  for (;;) {
    if (opts.signal?.aborted) {
      await link.cancel().catch(() => undefined);
      if (opts.json) io.out(`${JSON.stringify({ end: 'cancelled' })}\n`);
      else io.err('Pairing cancelled. Nothing changed.\n');
      return 130;
    }
    const s = await link.status();
    if (!s.open) {
      const end = s.last?.kind ?? 'cancelled';
      if (opts.json) io.out(`${JSON.stringify({ end, ...(s.last?.app ? { app: s.last.app } : {}) })}\n`);
      else if (end === 'joined') io.out(`Joined: this computer is now one of your devices, driven from ${s.last?.app ?? 'your app'}. \`beluga computers\` lists who may drive it.\n`);
      else if (end === 'declined') io.err('The app said no. Nothing changed.\n');
      else if (end === 'expired') io.err('The pairing expired before an app used it. Run `beluga pair --computer` again.\n');
      else io.err('The pairing was closed. Nothing changed.\n');
      return end === 'joined' ? 0 : 1;
    }
    const w = s.open.waiting;
    if (w && w.fingerprint !== shown) {
      shown = w.fingerprint;
      if (opts.json) io.out(`${JSON.stringify({ waiting: w.name, fingerprint: w.fingerprint })}\n`);
      else io.out(`“${w.name}” wants to add this computer. Check the app shows these same four pictures, then click Join there: ${w.fingerprint}\n`);
    }
    await pause(opts.pollMs ?? 500, opts.signal);
  }
}
