import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { TranscriptView, VoiceMacView } from '@beluga/companion/protocol.js';
import { suggestVoice, VOICE_MODELS, type VoiceModelId, voiceKnows, voiceSize } from '@beluga/shared/voice-models.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { insertText } from '../chat/paste-paths.js';
import { inApp } from './boot.js';
import { getPrefs, usePrefs, type UiPrefs } from './prefs.js';
import { joinPhrases, PhraseCutter, PHRASE_RATE, promptFrom, Resampler } from '@beluga/shared/voice-phrases.js';
import { cleanWords, DICTATION_MAX_SECONDS, HOLD_MS, matchesAccel, parseAccel, spoken, wavFromFloats } from './dictation-model.js';
import { isRecording } from './shortcuts.js';
import { microphoneSettings, thisComputer } from './os-words.js';

/**
 * Speak instead of typing (BLG-145): the microphone beside Send, and the talk shortcut (Settings ›
 * Voice). The window records (getUserMedia), and each pause cuts a phrase (BLG-160) that the daemon
 * writes down on the Mac's GPU at once (voice.transcribe: Whisper Turbo or Parakeet, the phone's On
 * your Mac engine), in order, while you keep talking; so when you stop, the words are ready. They go
 * in at the cursor of the box you were in, to read over; or, with Send right away, they're sent.
 *
 * The shortcut: hold it and talk, let go to write it in; or tap it, talk, then ↩ (or the shortcut
 * again). ⌘↩ writes it in and sends it whatever the setting; esc throws it away. "From any app"
 * registers it with macOS, so it brings Beluga forward and listens from wherever you are.
 */

/** A phrase cut at a pause: being written down, written, or not (it failed). */
export interface Phrase {
  readonly id: number;
  readonly status: 'writing' | 'done' | 'failed';
  readonly text?: string;
}

export type DictationState =
  | { readonly kind: 'off'; readonly error?: string }
  | { readonly kind: 'getting'; readonly model: VoiceModelId; readonly progress: number }
  | { readonly kind: 'listening'; readonly since: number; readonly phrases: readonly Phrase[] }
  /** Stopped: the last phrases are being written down (then they go in, or are sent). */
  | { readonly kind: 'writing'; readonly phrases: readonly Phrase[]; readonly send: boolean };

let state: DictationState = { kind: 'off' };
const subs = new Set<() => void>();
const set = (next: DictationState): void => {
  state = next;
  for (const f of [...subs]) f();
};
export const getDictation = (): DictationState => state;
export function useDictation(): DictationState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    getDictation,
  );
}

/* ---------- Where the words go: the boxes that take them ---------- */

interface Target {
  readonly el: () => HTMLTextAreaElement | null;
  readonly send: () => void;
  /** The conversation (or project page) it writes into, for your stats. */
  readonly channel: () => string | undefined;
}
const targets = new Set<Target>();
let lastTarget: Target | undefined;
/** The box the words go to while one is being written down. */
let into: Target | undefined;
export const dictatingInto = (el: HTMLTextAreaElement | null): boolean => state.kind !== 'off' && Boolean(el) && into?.el() === el;
/** What went wrong shows under the box it was meant for (or the first on screen, when there was none). */
export const errorIn = (el: HTMLTextAreaElement | null): string | undefined =>
  state.kind === 'off' && state.error && el && (into?.el()?.isConnected ? into.el() === el : pickTarget()?.el() === el) ? state.error : undefined;

/** A composer takes dictated words (and Send right away sends them with its own send). */
export function useDictationTarget(ref: React.RefObject<HTMLTextAreaElement | null>, send: () => void, channel?: string): void {
  const sendRef = useRef(send);
  sendRef.current = send;
  const channelRef = useRef(channel);
  channelRef.current = channel;
  useEffect(() => {
    const t: Target = { el: () => ref.current, send: () => sendRef.current(), channel: () => channelRef.current };
    targets.add(t);
    const focused = (): void => void (lastTarget = t);
    const el = ref.current;
    el?.addEventListener('focus', focused);
    if (el && document.activeElement === el) lastTarget = t;
    return () => {
      el?.removeEventListener('focus', focused);
      targets.delete(t);
      if (lastTarget === t) lastTarget = undefined;
    };
  }, [ref]);
}

/** The box you're in, else the one you were last in, else the first on screen (the chat's). */
function pickTarget(prefer?: HTMLTextAreaElement | null): Target | undefined {
  const live = [...targets].filter((t) => t.el()?.isConnected && !t.el()?.disabled);
  return live.find((t) => t.el() === prefer) ?? live.find((t) => t.el() === document.activeElement) ?? (lastTarget && live.includes(lastTarget) ? lastTarget : undefined) ?? live[0];
}

/* ---------- The model ---------- */

/** The model the setting means: Parakeet only for a language it knows (never for 'auto', which may be Turkish). */
export function voiceModelOf(p: Pick<UiPrefs, 'voiceModel' | 'voiceLanguage'>): VoiceModelId {
  const m: VoiceModelId = p.voiceModel === 'suggested' ? (suggestVoice({ macVoice: true, language: p.voiceLanguage }) === 'mac-fast' ? 'parakeet' : 'whisper-turbo') : p.voiceModel;
  return voiceKnows(m, p.voiceLanguage) ? m : 'whisper-turbo';
}

let client: SocketClient | undefined;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The model's here, or comes now (the bar shows how far; esc stops waiting): → it's ready. */
async function modelReady(model: VoiceModelId): Promise<boolean> {
  const api = client!.api;
  let v = (await api.voice.models()) as VoiceMacView;
  const here = (x: VoiceMacView) => x.models.find((m) => m.model === model);
  if (here(v)?.ready) return true;
  v = (await api.voice.prepare(model)) as VoiceMacView;
  for (;;) {
    const m = here(v);
    if (m?.ready) return true;
    if (m?.error && m.progress === undefined) throw new Error(m.error);
    if (state.kind !== 'getting') return false;
    set({ kind: 'getting', model, progress: m?.progress ?? 0 });
    await new Promise((r) => setTimeout(r, 800));
    if (state.kind !== 'getting') return false;
    v = (await api.voice.models()) as VoiceMacView;
  }
}

/* ---------- The waveform (read by the strip's canvas at its own pace, not through React) ---------- */

/** Each 30 ms of the recording: how loud, whether it was speech, and whether a phrase was cut there. */
export interface WaveFrame {
  readonly level: number;
  readonly speaking: boolean;
  cut?: boolean;
}
const WAVE_KEEP = 400;
let wave: WaveFrame[] = [];
/** The frames so far (the newest last): the strip draws the end of it. */
export const dictationWave = (): readonly WaveFrame[] => wave;

/* ---------- Recording, cut into phrases ---------- */

interface Recording {
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  readonly node: ScriptProcessorNode;
  readonly timer: ReturnType<typeof setTimeout>;
}
let rec: Recording | undefined;
/** The recording at 16 kHz (two minutes and a little), and how much of it there is. */
let samples = new Float32Array(0);
let heard = 0;
let cutter: PhraseCutter | undefined;
/** Phrases are written down one after another; `run` counts recordings, so a cancelled one's answers are dropped. */
let queue: Promise<void> = Promise.resolve();
let run = 0;
let phrases: Phrase[] = [];
/** The shortcut went down at (push-to-talk if it's held past HOLD_MS). */
let keyDownAt: number | undefined;

const phrasesNow = (): readonly Phrase[] => phrases;
function showPhrases(): void {
  if (state.kind === 'listening') set({ ...state, phrases: phrasesNow() });
  else if (state.kind === 'writing') set({ ...state, phrases: phrasesNow() });
}

function stopRecording(): void {
  const r = rec;
  rec = undefined;
  if (!r) return;
  clearTimeout(r.timer);
  r.node.onaudioprocess = null;
  r.node.disconnect();
  for (const t of r.stream.getTracks()) t.stop();
  void r.ctx.close().catch(() => undefined);
}

/** A phrase cut out: written down after the ones before it (with their words as Whisper's prompt). */
function writeDown(from: number, to: number): void {
  const mine = run;
  const id = phrases.length;
  const audio = samples.slice(from, to);
  phrases = [...phrases, { id, status: 'writing' }];
  showPhrases();
  const p = getPrefs();
  queue = queue.then(async () => {
    if (mine !== run || !client) return;
    let text: string | undefined;
    try {
      const wav = wavFromFloats(audio);
      let bin = '';
      for (let i = 0; i < wav.length; i += 0x8000) bin += String.fromCharCode(...wav.subarray(i, i + 0x8000));
      const before = joinPhrases(phrases.map((x) => x.text));
      const prompt = promptFrom(before);
      const r = (await client.api.voice.transcribe(btoa(bin), { model: voiceModelOf(p), language: p.voiceLanguage, ...(prompt ? { prompt } : {}) })) as TranscriptView;
      text = cleanWords(r.text);
    } catch {
      text = undefined;
    }
    if (mine !== run) return;
    phrases = phrases.map((x) => (x.id === id ? { id, status: text === undefined ? 'failed' : 'done', ...(text ? { text } : {}) } : x));
    showPhrases();
  });
}

/** Start listening, into the box you're in (or `prefer`). */
export async function startDictation(prefer?: HTMLTextAreaElement | null): Promise<void> {
  if (state.kind !== 'off' || !client) return;
  into = pickTarget(prefer);
  if (!into) return set({ kind: 'off', error: 'Open a chat to speak into' });
  const model = voiceModelOf(getPrefs());
  set({ kind: 'getting', model, progress: 0 });
  try {
    if (!(await modelReady(model))) return;
  } catch (e) {
    return set({ kind: 'off', error: `Couldn’t get ${VOICE_MODELS[model].label}: ${errorText(e)}` });
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    // Esc while macOS asked for the microphone.
    if (getDictation().kind !== 'getting') return void stream.getTracks().forEach((t) => t.stop());
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    const resample = new Resampler(ctx.sampleRate);
    run++;
    queue = Promise.resolve();
    phrases = [];
    wave = [];
    samples = new Float32Array(PHRASE_RATE * (DICTATION_MAX_SECONDS + 2));
    heard = 0;
    const c = (cutter = new PhraseCutter());
    c.onFrame = (level, speaking) => {
      wave.push({ level, speaking });
      if (wave.length > WAVE_KEEP) wave = wave.slice(-WAVE_KEEP);
    };
    node.onaudioprocess = (e) => {
      const at16 = resample.push(e.inputBuffer.getChannelData(0));
      const room = Math.min(at16.length, samples.length - heard);
      samples.set(at16.subarray(0, room), heard);
      heard += room;
      for (const cut of c.push(at16.subarray(0, room))) {
        const last = wave[wave.length - 1];
        if (last) last.cut = true;
        // A phrase of noise (a click, a cough) isn't worth writing down.
        if (cut.speechMs >= 200) writeDown(cut.start, cut.end);
      }
    };
    source.connect(node);
    node.connect(ctx.destination);
    rec = { stream, ctx, node, timer: setTimeout(() => void finishDictation(), DICTATION_MAX_SECONDS * 1000) };
    set({ kind: 'listening', since: Date.now(), phrases: [] });
  } catch (e) {
    stopRecording();
    const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    set({ kind: 'off', error: denied ? `Beluga can’t use the microphone: allow it in ${microphoneSettings()}` : `Couldn’t start listening: ${errorText(e)}` });
  }
}

/** Stop listening; when the last phrases are written down, the words go in (and are sent, when asked or set). */
export async function finishDictation(opts: { send?: boolean } = {}): Promise<void> {
  if (state.kind === 'getting') return cancelDictation();
  if (state.kind === 'writing' && opts.send) return set({ ...state, send: true });
  if (state.kind !== 'listening' || !client) return;
  stopRecording();
  // How long you spoke, and where, for your stats (the Usage tab): only the time, never the words.
  const spokeMs = Math.min(3_600_000, Math.round(Date.now() - state.since));
  const spokeIn = into?.channel();
  if (spokeMs > 0) void client.api.stats.note({ kind: 'dictation', ms: spokeMs, ...(spokeIn ? { channel: spokeIn } : {}) }).catch(() => undefined);
  const mine = run;
  const target = into;
  const last = cutter?.end();
  cutter = undefined;
  if (last && last.speechMs >= 200) writeDown(last.start, last.end);
  const p = getPrefs();
  set({ kind: 'writing', phrases: phrasesNow(), send: opts.send ?? p.voiceSend });
  await queue;
  const now = getDictation();
  if (mine !== run || now.kind !== 'writing') return;
  const send = now.send;
  const words = joinPhrases(phrases.map((x) => x.text));
  const failed = phrases.some((x) => x.status === 'failed');
  if (!target) return set({ kind: 'off' });
  if (!words) return set({ kind: 'off', error: failed ? 'Couldn’t write that down. Try again.' : 'Didn’t catch that. Try again a little closer to the microphone.' });
  const el = target.el();
  if (!el?.isConnected) return set({ kind: 'off', error: 'That chat closed before it was written down' });
  insertText(el, spoken(el.value.slice(0, el.selectionStart ?? el.value.length), words));
  set(failed ? { kind: 'off', error: 'A part of it couldn’t be written down: read it over.' } : { kind: 'off' });
  // After React has the words in its state; a part missing never goes unread.
  if (send && !failed) requestAnimationFrame(() => target.send());
}

export function cancelDictation(): void {
  stopRecording();
  run++;
  cutter = undefined;
  phrases = [];
  keyDownAt = undefined;
  set({ kind: 'off' });
}

/** The mic button: start, or write it in. */
export function toggleDictation(prefer?: HTMLTextAreaElement | null): void {
  if (state.kind === 'off') void startDictation(prefer);
  else if (state.kind === 'listening') void finishDictation();
  else if (state.kind === 'getting') cancelDictation();
}

export const clearDictationError = (): void => {
  if (state.kind === 'off' && state.error) set({ kind: 'off' });
};

/** The bar's words for the model coming. */
export const gettingLine = (s: Extract<DictationState, { kind: 'getting' }>): string =>
  s.progress > 0 ? `Getting ${VOICE_MODELS[s.model].label} on ${thisComputer()} · ${Math.round(s.progress * 100)}% of ${voiceSize(VOICE_MODELS[s.model].files.mac?.bytes ?? 0)}, once` : 'Getting ready…';

/* ---------- The shortcut ---------- */

/** The shortcut pressed: start (and note when, for push-to-talk), or, listening already, write it in. */
function shortcutDown(): void {
  if (state.kind === 'off') {
    keyDownAt = Date.now();
    void startDictation();
  } else if (state.kind === 'listening') {
    keyDownAt = undefined;
    void finishDictation();
  } else if (state.kind === 'getting') cancelDictation();
}
/** Let go after holding it: push-to-talk, so it's written in now. A tap keeps listening. */
function shortcutUp(): void {
  const held = keyDownAt !== undefined && Date.now() - keyDownAt >= HOLD_MS;
  keyDownAt = undefined;
  if (!held) return;
  if (state.kind === 'listening') void finishDictation();
  // Let go while it was still getting ready: nothing was said yet.
  else if (state.kind === 'getting') cancelDictation();
}

/** Mounted once (App): the API, the in-window shortcut, ↩ and esc while listening, and From any app. */
export function useDictationSetup(c: SocketClient): void {
  client = c;
  const prefs = usePrefs();
  const accel = prefs.voiceShortcut ? parseAccel(prefs.voiceShortcut) : undefined;
  const global = prefs.voiceAnyApp && inApp() && Boolean(accel);
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      // Settings › Keyboard is recording a shortcut: the keys are its.
      if (isRecording()) return;
      if (state.kind !== 'off') {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          return cancelDictation();
        }
        if (e.key === 'Enter' && (state.kind === 'listening' || state.kind === 'writing') && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          // ⌘↩ sends it, even while the last phrase is still being written down.
          return void finishDictation(e.metaKey || e.ctrlKey ? { send: true } : {});
        }
      }
      if (!accel || global || e.repeat || !matchesAccel(accel, e)) return;
      e.preventDefault();
      e.stopPropagation();
      shortcutDown();
    };
    const up = (e: KeyboardEvent): void => {
      if (accel && !global && e.code === accel.code) shortcutUp();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [accel?.code, accel?.cmd, accel?.ctrl, accel?.alt, accel?.shift, global]);

  // From any app: macOS hands Beluga the shortcut wherever you are; it comes forward and listens.
  useEffect(() => {
    if (!global) return;
    const shortcut = prefs.voiceShortcut;
    let alive = true;
    let registered = false;
    void import('@tauri-apps/plugin-global-shortcut')
      .then(async ({ register, unregister }) => {
        await register(shortcut, (ev) => {
          if (isRecording()) return;
          if (ev.state === 'Pressed') {
            void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
              const w = getCurrentWindow();
              await w.unminimize().catch(() => undefined);
              await w.show().catch(() => undefined);
              await w.setFocus().catch(() => undefined);
            });
            shortcutDown();
          } else shortcutUp();
        });
        registered = true;
        if (!alive) await unregister(shortcut);
      })
      .catch((e: unknown) => client?.store.dispatch({ type: 'toast', text: `The talk shortcut ${shortcut} couldn’t be set for every app (another app may use it): ${errorText(e)}`, level: 'warn' }));
    return () => {
      alive = false;
      if (registered) void import('@tauri-apps/plugin-global-shortcut').then(({ unregister }) => unregister(shortcut)).catch(() => undefined);
    };
  }, [global, prefs.voiceShortcut]);

  // Errors fade after a while.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const f = (): void => {
      if (t) clearTimeout(t);
      if (state.kind === 'off' && state.error) t = setTimeout(clearDictationError, 6000);
    };
    subs.add(f);
    return () => {
      subs.delete(f);
      if (t) clearTimeout(t);
    };
  }, []);
}
