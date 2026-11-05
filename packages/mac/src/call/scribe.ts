import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { TranscriptView, VoiceMacView } from '@beluga/companion/protocol.js';
import { PHRASE_RATE, PhraseCutter, Resampler, joinPhrases, promptFrom } from '@beluga/shared/voice-phrases.js';
import { type ScribeStatus, batchOf, bestModel, writeNow } from '@beluga/shared/scribe-plan.js';
import { type LanguageCount, callLanguage, countPhrase, languageCode, phraseLanguage, reported } from '@beluga/shared/call-language.js';
import { VOICE_MODEL_IDS, type VoiceModelId } from '@beluga/shared/voice-models.js';
import { cleanWords, wavFromFloats } from '../lib/dictation-model.js';
import { getPrefs } from '../lib/prefs.js';
import { repeat } from './repeat.js';

/**
 * Your words in a call, written down (BLG-715, BLG-718). Only your own microphone, the same
 * echo-cancelled, noise-suppressed stream the call sends (so the others' voices coming out of your
 * speakers aren't in it), cut at your pauses into phrases. Each phrase is written down by the Mac
 * in the call that will finish it soonest (`route`, the engine asks scribe-plan): this one when it
 * can, so no sound leaves it, else one with a model and time to spare, which sends the words back.
 *
 * Here, the writing down goes at the pace the Mac allows: with time to spare, each phrase at once
 * (nothing piles up); busy or on battery, a stretch at a time once enough has waited or the
 * processor quietens. Phrases other Macs send here are written down the same way. A phrase's sound
 * is dropped once it's written down; muted, nothing is heard.
 *
 * One language for the call (BLG-738, shared/call-language.ts): until it settles, each phrase's
 * language is the model's guess, and its sound is kept; once it settles, every phrase is written
 * down in it, and the early ones that came out in another language are written down again. Each
 * phrase goes with its language, so the Mac writing it down uses the same one; and that Mac uses
 * its best model for it (Whisper Turbo for Turkish, never Parakeet, which doesn't know it).
 */

export interface NotePhrase {
  readonly at: number;
  readonly text: string;
}

/** A phrase's sound, waiting to be written down: yours, or another's (`from`) to send back. */
interface Clip {
  readonly id: string;
  readonly at: number;
  readonly seconds: number;
  readonly wav: string;
  /** The language to write it down in ('auto': the model tells). */
  readonly lang: string;
  readonly from?: string;
  readonly queued: number;
}

/** A phrase of yours, written down; its sound is kept while the call's language isn't settled. */
interface Written {
  readonly id: string;
  readonly at: number;
  readonly seconds: number;
  readonly text: string;
  /** The language it came out in, if known. */
  readonly lang?: string;
  readonly wav?: string;
}

/** Phrases whose sound is kept until the call's language settles (about a minute of talk). */
const KEEP_FOR_REDO = 24;

/** A turn in a conversation ends at a shorter pause than a dictated paragraph does. */
const TUNING = { pauseMs: 900, maxPhraseMs: 20_000, minSpeechMs: 350 };
/** The last this many seconds of sound are kept (a phrase is never longer than the cut allows). */
const KEEP_SECONDS = 45;
/** How often the queue is looked at, and this Mac's load asked for. */
const PUMP_MS = 700;
const LOAD_MS = 5_000;

/** The voice models this Mac has ready to write a call down with (it never downloads one by itself). */
export async function scribeModels(client: SocketClient): Promise<VoiceModelId[]> {
  try {
    const v = (await client.api.voice.models()) as VoiceMacView;
    return VOICE_MODEL_IDS.filter((id) => v.models.some((m) => m.model === id && m.ready));
  } catch {
    return [];
  }
}

/** A WAV's samples as base64 (how phrases are written down here and sent to another Mac). */
const wavB64 = (audio: Float32Array): string => {
  const wav = wavFromFloats(audio);
  let bin = '';
  for (let i = 0; i < wav.length; i += 0x8000) bin += String.fromCharCode(...wav.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** Several phrases' sound as one recording, a short silence between them. */
function joined(wavs: readonly string[]): string {
  if (wavs.length === 1) return wavs[0]!;
  const parts = wavs.map((b) => {
    const bytes = Uint8Array.from(atob(b), (ch) => ch.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, 44, (bytes.length - 44) / 2);
    return Float32Array.from(pcm, (v) => v / 32768);
  });
  const gap = new Float32Array(PHRASE_RATE * 0.3);
  const total = parts.reduce((n, p) => n + p.length + gap.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length + gap.length;
  }
  return wavB64(out);
}

/** Words another Mac wrote down for a phrase, and the language they came out in. */
export interface Words {
  readonly text: string;
  readonly lang?: string;
}

export interface ScribeHooks {
  /** Who should write down a phrase of yours in `lang`: 'me', another Mac's id, or nobody (no model in the call knows it). */
  readonly route: (seconds: number, lang: string) => string | undefined;
  /** Send a phrase to another Mac to write down: its words, or undefined if it couldn't. */
  readonly delegate: (to: string, clip: { readonly id: string; readonly wav: string; readonly seconds: number; readonly lang: string }) => Promise<Words | undefined>;
  /** Words written down here for another Mac's phrase go back to it. */
  readonly giveBack: (to: string, id: string, words: Words) => void;
  /** What the other Macs in the call heard, by language (their scribe statuses). */
  readonly heard: () => readonly LanguageCount[];
}

export class Scribe {
  private ctx: AudioContext | undefined;
  private node: ScriptProcessorNode | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private readonly ring = new Float32Array(PHRASE_RATE * KEEP_SECONDS);
  private heard = 0;
  private cutter = new PhraseCutter(TUNING);
  private written: Written[] = [];
  /** Seconds of your phrases heard in each language. */
  private langs: LanguageCount = {};
  /** The call's language, once it settled (it doesn't change after). */
  private settledLang: string | undefined;
  /** Phrases waiting to be written down here (yours and others'), oldest first. */
  private waiting: Clip[] = [];
  /** Your phrases out at other Macs. */
  private out = 0;
  private busy = false;
  /** Your notes are paused: what you say isn't recorded (others' phrases are still written down here). */
  paused = false;
  private startedAt = 0;
  private stopped = false;
  private count = 0;
  /** Seconds of speech written down per second here (measured). */
  private speed: number | undefined;
  private load: { cpu?: number; battery?: boolean } = {};
  private readonly stops: Array<() => void> = [];
  private settled: (() => void) | undefined;

  /** A voice model is here; without one, every phrase goes to another Mac. */
  readonly ready: boolean;

  /** `models`: the voice models ready on this Mac. */
  constructor(
    private readonly client: SocketClient,
    private readonly hooks: ScribeHooks,
    readonly models: readonly VoiceModelId[],
  ) {
    this.ready = models.length > 0;
  }

  /** What this Mac says about itself as a scribe (the call shares it, scribe-plan decides with it). */
  status(by: string): ScribeStatus {
    return {
      by,
      ready: this.ready,
      backlog: Math.round(this.waiting.reduce((n, c) => n + c.seconds, 0)),
      ...(this.speed !== undefined ? { speed: Math.round(this.speed * 10) / 10 } : {}),
      ...this.load,
      models: this.models,
      ...(Object.keys(this.langs).length ? { langs: reported(this.langs) } : {}),
    };
  }

  /** The call's language, once enough was heard across the call; then the early phrases in another one are written down again. */
  language(): string | undefined {
    if (this.settledLang) return this.settledLang;
    const lang = callLanguage([this.langs, ...this.hooks.heard()]);
    if (lang) {
      this.settledLang = lang;
      this.redo(lang);
    }
    return lang;
  }

  /** The best model here for `lang`, if any knows it. */
  modelFor(lang: string): VoiceModelId | undefined {
    return bestModel(this.models, lang)?.model;
  }

  start(mic: MediaStream | undefined): void {
    this.startedAt = Date.now();
    this.stops.push(repeat(() => void this.pump(), PUMP_MS));
    const readLoad = (): void =>
      void this.client.api.voice
        .load()
        .then((l) => {
          const v = l as { cpu?: number; battery?: boolean };
          this.load = { ...(v.cpu !== undefined ? { cpu: v.cpu } : {}), ...(v.battery ? { battery: true } : {}) };
        })
        .catch(() => undefined);
    readLoad();
    this.stops.push(repeat(readLoad, LOAD_MS));
    if (!mic) return;
    const ctx = (this.ctx = new AudioContext());
    const source = (this.source = ctx.createMediaStreamSource(mic));
    const node = (this.node = ctx.createScriptProcessor(4096, 1, 1));
    const resample = new Resampler(ctx.sampleRate);
    node.onaudioprocess = (e) => {
      if (this.stopped || this.paused) return;
      const at16 = resample.push(e.inputBuffer.getChannelData(0));
      for (let i = 0; i < at16.length; i++) this.ring[(this.heard + i) % this.ring.length] = at16[i]!;
      this.heard += at16.length;
      for (const cut of this.cutter.push(at16)) if (cut.speechMs >= TUNING.minSpeechMs) this.cutOut(cut.start, cut.end);
    };
    source.connect(node);
    // A processor only runs connected; nothing is heard from it (it writes no output).
    node.connect(ctx.destination);
  }

  /** Another microphone, picked mid-call (BLG-737): your words are heard from it from now on. */
  listen(mic: MediaStream): void {
    if (!this.ctx || !this.node || this.stopped) return;
    this.source?.disconnect();
    this.source = this.ctx.createMediaStreamSource(mic);
    this.source.connect(this.node);
  }

  /** Another Mac's phrase to write down here, in `lang`, and send back (it decided this Mac was best). */
  serve(from: string, id: string, wav: string, seconds: number, lang = 'auto'): void {
    this.waiting.push({ id, at: Date.now(), seconds, wav, lang, from, queued: Date.now() });
  }

  /** The call is over for you: what's left is written down (here, or where it went), then everything you said. */
  async finish(): Promise<NotePhrase[]> {
    if (!this.stopped) {
      this.stopped = true;
      const last = this.cutter.end();
      if (last && last.speechMs >= TUNING.minSpeechMs) this.cutOut(last.start, last.end);
      if (this.node) {
        this.node.onaudioprocess = null;
        this.node.disconnect();
      }
      void this.ctx?.close().catch(() => undefined);
    }
    // What waits for you is written down now, however busy (the call is over); then the timers stop.
    const deadline = Date.now() + 120_000;
    while ((this.waiting.some((c) => !c.from) || this.out > 0 || this.busy) && Date.now() < deadline) {
      await this.pump(true);
      if (this.busy || this.out > 0) await new Promise<void>((r) => (this.settled = r));
    }
    for (const stop of this.stops) stop();
    return this.written
      .filter((w) => w.text)
      .map((w) => ({ at: w.at, text: w.text }))
      .sort((a, b) => a.at - b.at);
  }

  /** A phrase you said: written down here or sent to the Mac that will be sooner. */
  private cutOut(start: number, end: number): void {
    const from = Math.max(start, this.heard - this.ring.length);
    if (end <= from) return;
    const audio = new Float32Array(end - from);
    for (let i = 0; i < audio.length; i++) audio[i] = this.ring[(from + i) % this.ring.length]!;
    const at = this.startedAt + Math.round((from / PHRASE_RATE) * 1000);
    const seconds = audio.length / PHRASE_RATE;
    const lang = phraseLanguage(getPrefs().voiceLanguage, this.language());
    this.send({ id: `p${++this.count}`, at, seconds, wav: wavB64(audio), lang, queued: Date.now() });
  }

  /** A phrase of yours to write down: here, or at the Mac the plan picks. */
  private send(clip: Clip): void {
    const to = this.hooks.route(clip.seconds, clip.lang);
    if (to === undefined) return;
    if (to === 'me') {
      this.waiting.push(clip);
      return;
    }
    this.out++;
    void this.hooks
      .delegate(to, { id: clip.id, wav: clip.wav, seconds: clip.seconds, lang: clip.lang })
      .then((words) => {
        if (words?.text) this.keep(clip, words.text, words.lang);
        // It couldn't (left the call, no answer): written down here after all, if a model here knows it.
        else if (this.modelFor(clip.lang)) this.waiting.push(clip);
      })
      .finally(() => {
        this.out--;
        this.settled?.();
      });
  }

  /** A phrase of yours, written down: it counts for the call's language; its sound stays while that isn't settled. */
  private keep(clip: Clip, text: string, lang: string | undefined): void {
    const came = languageCode(lang) ?? languageCode(clip.lang);
    const redone = this.written.some((w) => w.id === clip.id);
    if (!redone) this.langs = countPhrase(this.langs, came, clip.seconds);
    const keepSound = !this.settledLang && clip.lang === 'auto' && this.written.filter((w) => w.wav).length < KEEP_FOR_REDO;
    const entry: Written = { id: clip.id, at: clip.at, seconds: clip.seconds, text, ...(came ? { lang: came } : {}), ...(keepSound ? { wav: clip.wav } : {}) };
    this.written = redone ? this.written.map((w) => (w.id === clip.id ? entry : w)) : [...this.written, entry];
    this.language();
  }

  /** The call settled on `lang`: phrases that came out in another one are written down again in it; the rest let their sound go. */
  private redo(lang: string): void {
    const again = this.written.filter((w) => w.wav && w.lang !== lang);
    this.written = this.written.map(({ wav: _wav, ...w }) => w);
    for (const w of again) this.send({ id: w.id, at: w.at, seconds: w.seconds, wav: w.wav!, lang, queued: Date.now() });
  }

  /** Write down what waits, if now is a good time (or `force`: the call is over). */
  private async pump(force = false): Promise<void> {
    if (this.busy || !this.ready || !this.waiting.length) return;
    // Others' phrases first: they're waiting on this Mac. Then yours, a stretch at a time when busy.
    const first = this.waiting[0]!;
    const theirs = this.waiting.filter((c) => c.from === (first.from ?? undefined));
    const seconds = theirs.reduce((n, c) => n + c.seconds, 0);
    if (!force && !writeNow(this.load, seconds, Date.now() - first.queued)) return;
    // Another Mac's phrases go one at a time (each goes back as its own); yours may go together, in one language.
    const batch = batchOf(
      theirs.filter((c) => c.lang === first.lang),
      Boolean(first.from) || first.lang === 'auto',
    );
    this.waiting = this.waiting.filter((c) => !batch.includes(c));
    const model = this.modelFor(first.lang);
    if (!model) {
      // No model here knows it: another Mac's goes back empty (it finds another way); yours is left out.
      if (first.from) this.hooks.giveBack(first.from, first.id, { text: '' });
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      // The last words in the same language set the tone (never another language's).
      const before = this.written.filter((w) => w.lang === (languageCode(first.lang) ?? this.settledLang)).slice(-4);
      const prompt = first.from ? undefined : promptFrom(joinPhrases(before.map((x) => x.text)));
      const r = (await this.client.api.voice.transcribe(joined(batch.map((c) => c.wav)), { model, language: first.lang, ...(prompt ? { prompt } : {}) })) as TranscriptView;
      const text = cleanWords(r.text);
      const lang = languageCode(r.language) ?? languageCode(first.lang);
      const took = (performance.now() - t0) / 1000;
      const done = batch.reduce((n, c) => n + c.seconds, 0) / Math.max(0.05, took);
      this.speed = this.speed === undefined ? done : this.speed * 0.6 + done * 0.4;
      if (first.from) {
        if (text) this.hooks.giveBack(first.from, first.id, { text, ...(lang ? { lang } : {}) });
      } else if (text) this.keep({ ...batch[0]!, seconds: batch.reduce((n, c) => n + c.seconds, 0) }, text, lang);
    } catch {
      // Not written down: left out (another Mac's comes back empty, it writes it down itself if it can).
      if (first.from) this.hooks.giveBack(first.from, first.id, { text: '' });
    } finally {
      this.busy = false;
      this.settled?.();
    }
  }
}

/** What you "said" in the demo's calls (the demo has no voice model): a few lines, seconds in. */
export function demoPhrases(startedAt: number): NotePhrase[] {
  return [
    [9, 'Yes, loud and clear.'],
    [33, 'Agreed, tax first and then the discount. I’ll check the order in checkout.ts.'],
    [58, 'Sounds good. I’ll review the fix this afternoon.'],
    [180, 'After tax, like the checkout page. Otherwise the numbers won’t match.'],
    [228, 'Good idea. And an expired code should fail before we charge anything.'],
    [300, 'Let’s refund the difference and say sorry, it’s the right thing to do.'],
    [420, 'Perfect. I’ll merge once the tests pass.'],
  ].map(([s, text]) => ({ at: startedAt + (s as number) * 1000, text: text as string }));
}
