import type { LanguageCount } from './call-language.js';
import { type VoiceModelId, voiceKnows } from './voice-models.js';

/**
 * Who writes down whose words in a call, and when (BLG-718). Every Mac records only its own
 * microphone, cut at its pauses into phrases. Each phrase is then written down by the best voice
 * model in the call for its language (BLG-738: Whisper Turbo over Parakeet for Turkish), and of the
 * Macs that have it, the one that will finish soonest: its own when it can (no sound leaves it),
 * else another that isn't busy and isn't on battery. And not word by word at any cost: a Mac with time
 * to spare writes each phrase down at once (captions stay live), a busy one waits and writes a
 * whole stretch down together when its processor quietens. Pure, so every Mac decides the same way.
 */

/** What a Mac says about itself as a scribe, every few seconds. */
export interface ScribeStatus {
  readonly by: string;
  /** A voice model is here and loaded. */
  readonly ready: boolean;
  /** How many seconds of speech it writes down per second (measured); unknown until it has. */
  readonly speed?: number;
  /** Seconds of speech waiting for it now (its own and others'). */
  readonly backlog: number;
  /** Its processor's load per core (0…1+). */
  readonly cpu?: number;
  /** On battery or in Low Power Mode. */
  readonly battery?: boolean;
  /** The voice models it has ready (older Beluga doesn't say: taken as one good model). */
  readonly models?: readonly VoiceModelId[];
  /** Seconds of its phrases heard in each language (BLG-738, shared/call-language.ts). */
  readonly langs?: LanguageCount;
}

/** How well a model writes down `lang` ('auto': not settled yet): 0 when it can't. */
export function modelQuality(model: VoiceModelId, lang: string): number {
  if (!voiceKnows(model, lang)) return 0;
  if (model === 'whisper-turbo') return 3;
  // Parakeet is as exact as Turbo in a language it knows, but it can't be told which one: until the
  // call's language is known it might hear one it doesn't (Turkish as Russian).
  if (model === 'parakeet') return lang === 'auto' ? 1 : 3;
  return 1;
}

/** The best model on a Mac for `lang`, and how good it is (undefined: none it can use). */
export function bestModel(models: readonly VoiceModelId[], lang: string): { readonly model: VoiceModelId; readonly quality: number } | undefined {
  let best: { model: VoiceModelId; quality: number } | undefined;
  // Turbo first: of two equally good, the one that knows every language.
  for (const model of [...models].sort((a, b) => (a === 'whisper-turbo' ? -1 : b === 'whisper-turbo' ? 1 : 0))) {
    const quality = modelQuality(model, lang);
    if (quality > 0 && (!best || quality > best.quality)) best = { model, quality };
  }
  return best;
}

/** How well a Mac would write down `lang` (an older Beluga that doesn't list its models: as Turbo). */
export function scribeQuality(s: ScribeStatus, lang: string): number {
  if (!s.ready) return 0;
  if (!s.models) return 3;
  return bestModel(s.models, lang)?.quality ?? 0;
}

/** A Mac with the best model may be this many times later than a lesser one, and still write it. */
const BEST_IS_WORTH = 4;
/** …unless it's further behind than this (seconds): then the phrase goes where it'll be written soon. */
const TOO_LATE_S = 45;

/** What a Mac with a model but no measure yet is taken to manage (Whisper Turbo on Apple silicon does far more). */
const GUESS_SPEED = 4;
/** Another Mac must be this much sooner before a phrase's sound is sent there. */
const WORTH_SENDING = 1.6;
/** Load per core above which a Mac counts as busy. */
export const BUSY_CPU = 0.7;
/** Most speech written down in one go (Whisper reads 30 s at a time). */
export const BATCH_SECONDS = 28;
/** However busy, nothing waits longer than this. */
export const LONGEST_WAIT_MS = 60_000;

/** About how long a Mac would take to have a phrase of `seconds` written down, counting what waits before it. */
export function eta(s: ScribeStatus, seconds: number): number {
  if (!s.ready) return Infinity;
  let t = (s.backlog + seconds) / Math.max(0.2, s.speed ?? GUESS_SPEED);
  if ((s.cpu ?? 0) > BUSY_CPU) t *= 2;
  if (s.battery) t *= 1.5;
  return t;
}

/**
 * Who writes down a phrase `owner` said in `lang`: of the Macs with the best model for it, the owner
 * unless another would be clearly sooner; a lesser model only when the best are far behind.
 * Undefined when nobody in the call can (no model anywhere that knows it: there are no notes).
 */
export function pickScribe(owner: string, statuses: readonly ScribeStatus[], seconds: number, lang = 'auto'): string | undefined {
  const able = statuses.filter((s) => scribeQuality(s, lang) > 0);
  if (!able.length) return undefined;
  const soonest = (list: readonly ScribeStatus[]): ScribeStatus => [...list].sort((a, b) => eta(a, seconds) - eta(b, seconds) || (a.by < b.by ? -1 : 1))[0]!;
  const top = Math.max(...able.map((s) => scribeQuality(s, lang)));
  const finest = able.filter((s) => scribeQuality(s, lang) === top);
  const anyone = soonest(able);
  const best = soonest(finest);
  const tooSlow = eta(best, seconds) > TOO_LATE_S && eta(best, seconds) > eta(anyone, seconds) * BEST_IS_WORTH;
  const pool = tooSlow ? able : finest;
  const pick = tooSlow ? anyone : best;
  const own = pool.find((s) => s.by === owner);
  if (own && eta(own, seconds) <= eta(pick, seconds) * WORTH_SENDING) return owner;
  return pick.by;
}

/**
 * Whether to write down what's waiting now: at once with time to spare (one phrase at a time keeps
 * captions live); when busy or on battery, a stretch at a time, once there's enough of it or the
 * oldest has waited long enough, so the model wakes up less often and the call stays smooth.
 */
export function writeNow(s: Pick<ScribeStatus, 'cpu' | 'battery'>, waitingSeconds: number, oldestAgeMs: number): boolean {
  if (waitingSeconds <= 0) return false;
  if (oldestAgeMs >= LONGEST_WAIT_MS) return true;
  const busy = (s.cpu ?? 0) > BUSY_CPU;
  if (busy) return waitingSeconds >= BATCH_SECONDS;
  if (s.battery) return waitingSeconds >= BATCH_SECONDS / 2 || oldestAgeMs >= LONGEST_WAIT_MS / 2;
  return true;
}

/** The first phrases of a queue that fit in one go (one at least). */
export function batchOf<T extends { readonly seconds: number }>(queue: readonly T[], one: boolean): T[] {
  if (one) return queue.slice(0, 1);
  const out: T[] = [];
  let total = 0;
  for (const c of queue) {
    if (out.length && total + c.seconds > BATCH_SECONDS) break;
    out.push(c);
    total += c.seconds;
  }
  return out;
}
