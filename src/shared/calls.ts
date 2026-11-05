/**
 * Calls in a conversation (BLG-706): what screens see of one, and the rules every Mac in it follows
 * the same way, so nobody has to coordinate. Browser-safe: it imports only other pure shared modules.
 *
 * The daemon rings, keeps who's in, and passes WebRTC setup between Macs over the friends' Noise
 * links (core/calls). The Mac's window makes the media: voice to everyone in the call (a mesh), a
 * screen share through a fan-out tree (`shareTree`) once there are more viewers than the sharer
 * should feed alone.
 */

import { type LanguageCount, languageCode } from './call-language.js';
import { VOICE_MODEL_IDS, type VoiceModelId } from './voice-models.js';

/** Someone in a call, as screens show them. */
export interface CallPersonView {
  readonly peerId: string;
  readonly name: string;
  readonly me?: true;
  readonly muted: boolean;
  /** Sharing their screen now. */
  readonly sharing: boolean;
  /** Their camera is on (BLG-714). */
  readonly camera?: boolean;
  /** About how much they can send (kbit/s, their own measure, BLG-717): the share relays through the best. */
  readonly uplink?: number;
  readonly joinedAt: number;
}

/** A conversation's call. `mine`: whether you're in it, it's ringing for you, or you're not in it. */
export interface CallView {
  readonly id: string;
  readonly conversation: string;
  readonly startedBy: string;
  readonly startedAt: number;
  /** Who's in it now (you too, when you are), in the order they joined. */
  readonly people: readonly CallPersonView[];
  readonly mine: 'in' | 'ringing' | 'out';
  /** Who rang you (while it rings). */
  readonly ringBy?: string;
  /** Since when it rings for you; it stops ringing after `RING_MS`. */
  readonly ringSince?: number;
  /** The demo's network: the others make no sound, so the window plays their side itself. */
  readonly demo?: true;
}

/** The calls in your conversations, by conversation id (`dm:…` / `group:…`). */
export type CallsView = Readonly<Record<string, CallView>>;

/** A call that rang for you and stopped before you answered or declined it: "Ann tried calling you at 14:05". */
export interface MissedCallView {
  readonly id: string;
  readonly conversation: string;
  /** Who rang (their peer id), and their name. */
  readonly by: string;
  readonly name: string;
  /** When it started ringing here. */
  readonly at: number;
}

/** "Ann tried calling you at 14:05" (with the day too when it wasn't today). */
export function missedCallText(m: Pick<MissedCallView, 'name' | 'at'>, now = Date.now()): string {
  const when = new Date(m.at);
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = when.toDateString() === new Date(now).toDateString();
  return `${m.name} tried calling you at ${time}${today ? '' : ` on ${when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`}`;
}

/** How long a call rings before it counts as missed. */
export const RING_MS = 45_000;
/** Each Mac in a call says it's still there this often… */
export const HEARTBEAT_MS = 10_000;
/** …and is taken out of the roster when nothing came from it for this long. */
export const GONE_MS = 32_000;

/** The biggest WebRTC setup message (an offer with many candidates stays far below it). */
export const SIGNAL_MAX = 64 * 1024;

/** How many viewers the sharer feeds directly; everyone after them is fed by a viewer. */
export const SHARE_FANOUT = 3;
/** How many viewers each viewer passes the share on to, at most. */
export const RELAY_FANOUT = 2;

/**
 * Who feeds whom with a screen share: `viewers` in the order they joined (every Mac knows the same
 * order, so they all draw the same tree). The first `SHARE_FANOUT` get it from the sharer; viewer
 * k after them from viewer ⌊(k − SHARE_FANOUT) / RELAY_FANOUT⌋, so a share to 15 people costs the
 * sharer 3 streams and nobody more than 2 more. → each viewer's source (the sharer or a viewer).
 */
export function shareTree(sharer: string, viewers: readonly string[]): ReadonlyMap<string, string> {
  const tree = new Map<string, string>();
  viewers.forEach((v, i) => tree.set(v, i < SHARE_FANOUT ? sharer : viewers[Math.floor((i - SHARE_FANOUT) / RELAY_FANOUT)]!));
  return tree;
}

/** What one screen share takes (kbit/s), to count how many someone can pass on. */
export const SHARE_KBPS = 2_500;
/** Most viewers anyone feeds directly, however good their connection. */
const MOST_FED = 5;

/**
 * The share tree for a call of any size (BLG-717): the best uploads closest to the sharer. Viewers
 * go in order of how much they can send (each Mac says it; ties by when they joined, so every Mac
 * draws the same tree), and each feeds as many as its upload carries (one at least, five at
 * most), the sharer first. Someone on a weak connection only watches.
 */
export function shareTreeBy(sharer: { readonly peerId: string; readonly uplink?: number }, viewers: ReadonlyArray<{ readonly peerId: string; readonly uplink?: number; readonly joinedAt: number }>): ReadonlyMap<string, string> {
  const fanout = (uplink: number | undefined, fallback: number): number => (uplink === undefined ? fallback : Math.max(1, Math.min(MOST_FED, Math.floor((uplink * 0.8) / SHARE_KBPS))));
  const order = [...viewers].sort((a, b) => (b.uplink ?? 0) - (a.uplink ?? 0) || a.joinedAt - b.joinedAt || (a.peerId < b.peerId ? -1 : 1));
  const tree = new Map<string, string>();
  // Feeders in order, each with the room it has left.
  const feeders: Array<{ id: string; left: number }> = [{ id: sharer.peerId, left: fanout(sharer.uplink, SHARE_FANOUT) }];
  let at = 0;
  for (const v of order) {
    while (at < feeders.length && feeders[at]!.left <= 0) at++;
    const f = feeders[Math.min(at, feeders.length - 1)]!;
    tree.set(v.peerId, f.id);
    f.left--;
    feeders.push({ id: v.peerId, left: fanout(v.uplink, RELAY_FANOUT) });
  }
  return tree;
}

/** Whom `peerId` sends the share on to (their children in `shareTree`). */
export function shareChildren(tree: ReadonlyMap<string, string>, peerId: string): string[] {
  return [...tree].filter(([, from]) => from === peerId).map(([to]) => to);
}

/** The person sharing in a call (the one who started sharing last wins the stage), if anyone. */
export function sharerOf(call: Pick<CallView, 'people'>): CallPersonView | undefined {
  return call.people.filter((p) => p.sharing).at(-1);
}

/** Of two calls one conversation ended up with (two people pressed Call at once), the one everyone keeps. */
export const keeps = (a: string, b: string): string => (a < b ? a : b);

/** "4:05", "1:02:09": how long a call has been going. */
export function callLength(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * What goes between the windows in a call, on the WebRTC data channel (strokes and pointers never
 * touch the daemon). Points are fractions of the shared picture (0…1), so they land in the same
 * place on any size of screen.
 */
export type StageMessage =
  /** Where `by`'s pointer is now (`x` < 0: they stopped); sent many times a second, on the pointers channel when there is one. */
  | { readonly k: 'laser'; readonly by: string; readonly x: number; readonly y: number }
  /** A stroke of ink being drawn: its points so far (sent again as it grows), in `color`. */
  | { readonly k: 'ink'; readonly by: string; readonly id: string; readonly color: string; readonly pts: readonly number[]; readonly done?: boolean }
  /** Take every stroke and mark away (`mine`: only `by`'s own). */
  | { readonly k: 'clear'; readonly by: string; readonly mine?: boolean }
  /** A click on the screen: a ripple there everyone sees. */
  | { readonly k: 'ping'; readonly by: string; readonly x: number; readonly y: number }
  /** A box someone marked: shown to everyone, fading (or kept until it's taken away, `keep`). */
  | { readonly k: 'mark'; readonly by: string; readonly id: string; readonly box: Box; readonly keep?: boolean }
  | { readonly k: 'unmark'; readonly by: string; readonly id: string }
  /** How the sharer sends their screen: sharp for text, smooth for motion (relays pass it on the same way). */
  | { readonly k: 'mode'; readonly by: string; readonly mode: ShareMode }
  /** Whose cameras this window shows big (the rest small; `visible` false: none on screen), so senders size each one for it. */
  | { readonly k: 'view'; readonly by: string; readonly big: readonly string[]; readonly visible: boolean }
  /** How a Mac does as a scribe (BLG-718, shared/scribe-plan.ts): a model or not, how fast, how busy. */
  | { readonly k: 'scribe'; readonly by: string; readonly ready: boolean; readonly speed?: number; readonly backlog: number; readonly cpu?: number; readonly battery?: boolean; readonly models?: readonly VoiceModelId[]; readonly langs?: LanguageCount }
  /** A phrase's sound for the Mac that will write it down soonest: a WAV (base64) in parts. */
  | { readonly k: 'clip'; readonly by: string; readonly id: string; readonly part: number; readonly parts: number; readonly seconds: number; readonly b64: string; readonly lang?: string }
  /** The words of a phrase another Mac sent here to write down (empty: it couldn't). */
  | { readonly k: 'clip-text'; readonly by: string; readonly id: string; readonly text: string; readonly lang?: string }
  /** Which of a window's streams is its camera and which its screen (WebRTC only says a stream's id). */
  | { readonly k: 'streams'; readonly by: string; readonly cam?: string; readonly screen?: string; readonly pointers?: boolean }
  /** Someone asked Claude about the share; the answer comes as a chat message (`ask` names it). */
  | { readonly k: 'asked'; readonly by: string; readonly ask: string; readonly box?: readonly [number, number, number, number] };

/** A part of the shared picture: x, y, width, height, in fractions of it. */
export type Box = readonly [number, number, number, number];

/** Sharp: every pixel of text, fewer frames. Smooth: every frame, fewer pixels when the network is tight. */
export type ShareMode = 'sharp' | 'smooth';

/** The most base64 one `clip` part carries (a data channel message stays well under its limit). */
export const CLIP_PART = 48_000;

/** Ink fades this long after it's done. */
export const INK_FADE_MS = 4_000;

/** The language a phrase is to be written down in: a code, or 'auto'. */
const phraseLang = (v: unknown): string | undefined => (v === 'auto' ? 'auto' : languageCode(v));

/** Parse a data channel message; undefined for anything malformed (it comes from another Mac). */
export function parseStage(text: string): StageMessage | undefined {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  const by = typeof o['by'] === 'string' && o['by'].length <= 64 ? o['by'] : undefined;
  if (!by) return undefined;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  switch (o['k']) {
    case 'laser':
      return num(o['x']) && num(o['y']) ? { k: 'laser', by, x: o['x'], y: o['y'] } : undefined;
    case 'ink': {
      const pts = o['pts'];
      const color = o['color'];
      const id = o['id'];
      if (!Array.isArray(pts) || pts.length > 4000 || !pts.every(num) || typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color) || typeof id !== 'string' || id.length > 40) return undefined;
      return { k: 'ink', by, id, color, pts, ...(o['done'] === true ? { done: true } : {}) };
    }
    case 'clear':
      return { k: 'clear', by, ...(o['mine'] === true ? { mine: true } : {}) };
    case 'ping':
      return num(o['x']) && num(o['y']) ? { k: 'ping', by, x: o['x'], y: o['y'] } : undefined;
    case 'mark': {
      const id = o['id'];
      const box = o['box'];
      if (typeof id !== 'string' || id.length > 40 || !Array.isArray(box) || box.length !== 4 || !box.every(num)) return undefined;
      return { k: 'mark', by, id, box: box as unknown as Box, ...(o['keep'] === true ? { keep: true } : {}) };
    }
    case 'unmark':
      return typeof o['id'] === 'string' && o['id'].length <= 40 ? { k: 'unmark', by, id: o['id'] } : undefined;
    case 'mode':
      return o['mode'] === 'sharp' || o['mode'] === 'smooth' ? { k: 'mode', by, mode: o['mode'] } : undefined;
    case 'view': {
      const big = o['big'];
      if (!Array.isArray(big) || big.length > 32 || !big.every((b) => typeof b === 'string' && b.length <= 200)) return undefined;
      return { k: 'view', by, big: big as string[], visible: o['visible'] !== false };
    }
    case 'scribe': {
      if (typeof o['ready'] !== 'boolean' || !num(o['backlog'])) return undefined;
      const models = Array.isArray(o['models']) ? o['models'].filter((m): m is VoiceModelId => (VOICE_MODEL_IDS as readonly unknown[]).includes(m)).slice(0, VOICE_MODEL_IDS.length) : undefined;
      const rawLangs = o['langs'] && typeof o['langs'] === 'object' && !Array.isArray(o['langs']) ? Object.entries(o['langs'] as Record<string, unknown>).slice(0, 8) : [];
      const langs = Object.fromEntries(rawLangs.filter((e): e is [string, number] => Boolean(languageCode(e[0])) && num(e[1]) && e[1] >= 0 && e[1] < 1e6));
      return {
        k: 'scribe',
        by,
        ready: o['ready'],
        backlog: o['backlog'],
        ...(num(o['speed']) ? { speed: o['speed'] } : {}),
        ...(num(o['cpu']) ? { cpu: o['cpu'] } : {}),
        ...(o['battery'] === true ? { battery: true } : {}),
        ...(models ? { models } : {}),
        ...(Object.keys(langs).length ? { langs } : {}),
      };
    }
    case 'clip': {
      const id = o['id'];
      const b64 = o['b64'];
      const ok = typeof id === 'string' && id.length <= 40 && typeof b64 === 'string' && b64.length <= CLIP_PART && /^[A-Za-z0-9+/=]*$/.test(b64);
      if (!ok || !num(o['part']) || !num(o['parts']) || !num(o['seconds']) || o['parts'] > 64 || o['part'] >= o['parts'] || o['seconds'] > 40) return undefined;
      return { k: 'clip', by, id, part: o['part'], parts: o['parts'], seconds: o['seconds'], b64, ...(phraseLang(o['lang']) ? { lang: phraseLang(o['lang'])! } : {}) };
    }
    case 'clip-text':
      return typeof o['id'] === 'string' && o['id'].length <= 40 && typeof o['text'] === 'string' && o['text'].length <= 8_000 ? { k: 'clip-text', by, id: o['id'], text: o['text'], ...(languageCode(o['lang']) ? { lang: languageCode(o['lang'])! } : {}) } : undefined;
    case 'streams': {
      const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100;
      return { k: 'streams', by, ...(id(o['cam']) ? { cam: o['cam'] } : {}), ...(id(o['screen']) ? { screen: o['screen'] } : {}), ...(o['pointers'] === true ? { pointers: true } : {}) };
    }
    case 'asked': {
      const box = o['box'];
      const ask = o['ask'];
      if (typeof ask !== 'string' || ask.length > 80) return undefined;
      const okBox = Array.isArray(box) && box.length === 4 && box.every(num);
      return { k: 'asked', by, ask, ...(okBox ? { box: box as unknown as [number, number, number, number] } : {}) };
    }
    default:
      return undefined;
  }
}

/** One thing said in a call, in its notes (BLG-715). */
export interface NotesLine {
  /** Who said it (their peer id), and their name. */
  readonly by: string;
  readonly name: string;
  readonly at: number;
  readonly text: string;
}

/** A call's notes: everyone's words merged in the order they were said; `sent` says whose words are in. */
export interface CallNotesView {
  readonly id: string;
  readonly conversation: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly people: ReadonlyArray<{ readonly peerId: string; readonly name: string; readonly sent: boolean }>;
  readonly lines: readonly NotesLine[];
}

/** The most notes text an agent reads from a conversation's calls (the latest of it). */
export const NOTES_KEPT = 40_000;
