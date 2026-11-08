/**
 * Speaking instead of typing in the Mac app (BLG-145), the parts without a microphone or a window
 * so they can be tested: the talk shortcut (an accelerator, as Tauri's global shortcuts write it:
 * "Alt+Space", "CommandOrControl+Shift+D"), the recording turned into the 16 kHz WAV the daemon
 * writes down, and where the words go in the box.
 */

import { keyPlatform } from './shortcuts-model.js';

const isMacKeys = (): boolean => keyPlatform() === 'mac';

/** Whisper's sample rate: what the Mac writes down from. */
export const DICTATION_RATE = 16_000;
/** The longest one recording runs before it's written down by itself (2 minutes). */
export const DICTATION_MAX_SECONDS = 120;
/** Held at least this long, the shortcut was push-to-talk (letting go writes it down); shorter, a tap (it keeps listening). */
export const HOLD_MS = 350;
export const DEFAULT_SHORTCUT = 'Alt+Space';

export interface Accel {
  readonly cmd: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** KeyboardEvent.code: KeyD, Digit1, Space, F5, Backquote… */
  readonly code: string;
}

const MOD_NAMES: Record<string, keyof Omit<Accel, 'code'>> = { cmd: 'cmd', command: 'cmd', super: 'cmd', meta: 'cmd', commandorcontrol: 'cmd', cmdorctrl: 'cmd', ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift' };

/** The key's name in an accelerator, from KeyboardEvent.code ('KeyD' → 'D', 'Digit1' → '1'). */
export function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

/** An accelerator → its parts (undefined: not one, or no modifier on a letter, digit or Space, which typing needs). */
export function parseAccel(s: string): Accel | undefined {
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return undefined;
  const a = { cmd: false, ctrl: false, alt: false, shift: false };
  for (const p of parts) {
    const m = MOD_NAMES[p.toLowerCase()];
    if (!m) return undefined;
    a[m] = true;
  }
  const code = /^[A-Za-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key;
  const plainKey = /^(Key[A-Z]|Digit\d|Space|Enter|Backspace|Tab|Escape)$/.test(code);
  if (plainKey && !a.cmd && !a.ctrl && !a.alt) return undefined;
  if (code === 'Escape' || code === 'Enter') return undefined;
  return { ...a, code };
}

/** The accelerator for a key press (the Settings recorder), or undefined while only modifiers are down. */
export function accelOf(e: { readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; readonly code: string }, onMac = isMacKeys()): string | undefined {
  if (/^(Meta|Control|Alt|Shift|OS)(Left|Right)?$/.test(e.code) || !e.code) return undefined;
  // Off the Mac, Ctrl is the main modifier (CommandOrControl); the Windows key isn't one.
  const mods = (onMac ? [e.metaKey && 'CommandOrControl', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift'] : [e.ctrlKey && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift']).filter(Boolean);
  return [...mods, keyName(e.code)].join('+');
}

/** This key press is the shortcut (the code, not the character: ⌥ changes those on a Mac). */
export function matchesAccel(a: Accel, e: { readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean; readonly code: string }, onMac = isMacKeys()): boolean {
  // Off the Mac, CommandOrControl and Control are both Ctrl.
  const mods = onMac ? e.metaKey === a.cmd && e.ctrlKey === a.ctrl : e.ctrlKey === (a.cmd || a.ctrl);
  return e.code === a.code && mods && e.altKey === a.alt && e.shiftKey === a.shift;
}

/** The shortcut as this computer shows it: ⌃⌥⇧⌘ then the key on a Mac, "Ctrl+Alt+Shift+" elsewhere. */
export function accelLabel(s: string, onMac = isMacKeys()): string {
  const a = parseAccel(s);
  if (!a) return s;
  const key = keyName(a.code);
  const shown: Record<string, string> = { Space: 'Space', Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\' };
  if (!onMac) return [(a.cmd || a.ctrl) && 'Ctrl', a.alt && 'Alt', a.shift && 'Shift', shown[key] ?? key].filter(Boolean).join('+');
  return `${a.ctrl ? '⌃' : ''}${a.alt ? '⌥' : ''}${a.shift ? '⇧' : ''}${a.cmd ? '⌘' : ''}${shown[key] ?? key}`;
}

/** The recording at the microphone's rate → 16 kHz, each output sample the mean of the input it covers. */
export function downsample(input: Float32Array, rate: number, to = DICTATION_RATE): Float32Array {
  if (rate === to) return input;
  const ratio = rate / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < end; j++) sum += input[j]!;
    out[i] = end > from ? sum / (end - from) : 0;
  }
  return out;
}

/** Floats in [-1, 1] → a 16 kHz mono 16-bit WAV file. */
export function wavFromFloats(samples: Float32Array, rate = DICTATION_RATE): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** How loud a stretch is, 0 to 1, for the listening bar (speech sits around an RMS of 0.02–0.2). */
export function levelOf(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length) / 0.2));
}

/** Whisper's notes on the sound, not words: [BLANK_AUDIO], (music), ♪. */
export function cleanWords(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words as they go in at the cursor: a space first when they'd touch the word before. */
export function spoken(before: string, words: string): string {
  return before && !/\s$/.test(before) ? ` ${words}` : words;
}

/* ---------- The microphone (Settings › Voice › Microphone) ---------- */

export interface Microphone {
  readonly id: string;
  readonly label: string;
}

/**
 * The microphones on this computer, from enumerateDevices: each once ('default' and 'communications'
 * are macOS's own pointing at one of them), and a name for the ones WebKit doesn't name yet.
 */
export function microphonesOf(all: readonly { readonly kind: string; readonly deviceId: string; readonly label: string }[]): Microphone[] {
  return all
    .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

/** What dictation asks the microphone for: the one picked ('' : macOS's own), or macOS's own when it's unplugged. */
export function dictationAudio(mic: string): MediaTrackConstraints {
  return { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(mic ? { deviceId: { ideal: mic } } : {}) };
}
