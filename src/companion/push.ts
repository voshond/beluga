import { execFile } from 'node:child_process';
import type { Topic } from './protocol.js';

/**
 * Telling your phone something (docs/companion.md, "Battery" and "Notifications"). While it's
 * linked, a `nudge` goes over the link; while it isn't, a push through Beluga Push (a blind relay
 * to FCM / APNs, not built yet: the default Pusher sends nothing). And only when it's worth it:
 * never about what the phone has on screen, and no push while you're at the Mac.
 */

export type NudgeKind = 'needsYou' | 'done' | 'mentions';

export interface Nudge {
  readonly kind: NudgeKind;
  readonly title: string;
  readonly body: string;
  readonly topic?: Topic;
  /** Something that needs you is high priority (it wakes the phone); the rest batches under a collapse key. */
  readonly priority: 'high' | 'normal';
  readonly collapse?: string;
  /** Only for a phone linked with the app in the background (Stay connected), never pushed: the Mac's own "finished" notices. */
  readonly away?: boolean;
}

/** A phone that can be pushed to (its token and relay key, from its `push` frame). */
export interface PushTarget {
  readonly deviceId: string;
  readonly platform: 'fcm' | 'apns';
  readonly token: string;
  readonly relayKey: string;
  /** Its X25519 key (hex): what's pushed is sealed to it, so the relay and FCM see only ciphertext. */
  readonly box: string;
}

export interface Pusher {
  push(target: PushTarget, nudge: Nudge): Promise<void>;
}

/**
 * No relay yet: nothing is pushed. When Beluga Push exists, its Pusher seals the nudge to the
 * phone's box key with sodium's crypto_box_seal (so the phone, in Bare or in a notification
 * extension, opens it with the same library) and posts `{token, sealed, priority, collapse}`.
 */
export const NO_PUSH: Pusher = { push: async () => undefined };

/**
 * You're at the Mac when its keyboard or mouse was used within this long (BLG-360): the phone
 * stays quiet, since you see it there. Five minutes without a touch and the phone is told.
 */
export const AWAY_AFTER_MS = 5 * 60_000;

export interface PushContext {
  /** The phone is linked now (a nudge goes over the link instead). */
  readonly linked: boolean;
  /** What it has on screen (its subscribed topics) and whether the app is in front. */
  readonly onScreen: ReadonlySet<string>;
  readonly inFront: boolean;
  /** How long since you last touched the Mac's keyboard or mouse (undefined: unknown). */
  readonly macIdleMs?: number;
  /** A Beluga window on the Mac is in front (state.attention.front). */
  readonly macFront: boolean;
  /** The phone can be pushed to at all. */
  readonly canPush: boolean;
}

/** `held`: you're at the Mac, so not now; told later if it's still waiting once you've stepped away. */
export type Delivery = 'nudge' | 'push' | 'held' | 'none';

/**
 * You're at the Mac: its keyboard or mouse was used in the last five minutes. When that can't be
 * read (not a Mac), a Beluga window in front stands in for it.
 */
export const atMac = (ctx: Pick<PushContext, 'macIdleMs' | 'macFront'>): boolean => (ctx.macIdleMs !== undefined ? ctx.macIdleMs < AWAY_AFTER_MS : ctx.macFront);

/**
 * How (and whether) to tell one phone something. The app open on the phone hears it in the app
 * (a toast), wherever you are; otherwise a notification only once you've been away from the Mac
 * five minutes (a linked phone in the background gets it as a nudge, an unlinked one as a push).
 */
export function deliver(nudge: Pick<Nudge, 'kind' | 'topic'>, ctx: PushContext): Delivery {
  // Already looking at it on the phone: nothing to say.
  if (ctx.linked && ctx.inFront && nudge.topic && ctx.onScreen.has(nudge.topic)) return 'none';
  if (ctx.linked && ctx.inFront) return 'nudge';
  if (!ctx.linked && !ctx.canPush) return 'none';
  // You're at the Mac: you see it there.
  if (atMac(ctx)) return 'held';
  return ctx.linked ? 'nudge' : 'push';
}

/** How long since the last key press or mouse move (Windows: GetLastInputInfo), in ms. */
const WINDOWS_IDLE_PS = `Add-Type -Name I -Namespace Beluga -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct L { public uint cb; public uint t; } [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref L l);'
$l = New-Object Beluga.I+L; $l.cb = 8; [void][Beluga.I]::GetLastInputInfo([ref]$l); [Environment]::TickCount - $l.t`;

/** Each system's way to ask, and how to read its answer as milliseconds. */
const IDLE: Partial<Record<NodeJS.Platform, readonly [string, readonly string[], (out: string) => number | undefined]>> = {
  // IOKit's HIDIdleTime, via ioreg, in nanoseconds.
  darwin: ['ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'], (out) => {
    const ns = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out)?.[1];
    return ns ? Math.round(Number(ns) / 1e6) : undefined;
  }],
  // X11 only (Wayland doesn't tell other apps): xprintidle, when it's installed.
  linux: ['xprintidle', [], (out) => (/^\d+$/.test(out.trim()) ? Number(out.trim()) : undefined)],
  win32: ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_IDLE_PS], (out) => (/^-?\d+$/.test(out.trim()) ? Math.max(0, Number(out.trim())) : undefined)],
};

/**
 * The keyboard's idle time, only while a Beluga window is open to see things in. With none (a
 * server, a Mac mini with the app closed) someone typing there isn't you at Beluga: undefined,
 * so `atMac` goes by the (absent) window in front and the phone is told straight away.
 */
export function idleWhenWatched(screens: () => number, idle: () => Promise<number | undefined> = macIdleMs): () => Promise<number | undefined> {
  return () => (screens() > 0 ? idle() : Promise.resolve(undefined));
}

/**
 * Milliseconds since you last used this computer's keyboard or mouse, or undefined when it can't
 * tell. Cheap enough to ask when there's something to push.
 */
export function macIdleMs(): Promise<number | undefined> {
  const how = IDLE[process.platform];
  if (!how) return Promise.resolve(undefined);
  const [cmd, args, read] = how;
  return new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: 3_000 }, (err, out) => resolve(err ? undefined : read(String(out))));
  });
}
