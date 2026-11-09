import { DEFAULT_SOUND, DEFAULT_VOLUME, NO_SOUND, type SoundChoice, type SoundPrefs, volumeOf } from '../../../../../src/shared/notify-sound.js';
import { inApp } from '../boot.js';
import { keyPlatform } from '../shortcuts-model.js';
import { filesInUse, playableHere, renderChoice, soundFileName, soundsInUse } from './catalog.js';
import { playSound } from './player.js';
import { SAMPLE_RATE } from './synth.js';
import { testTone } from './test-sound.js';
import { encodeWav } from './wav.js';

/**
 * Getting a notification's sound to macOS: Mac sounds go by their name; Beluga's own are
 * written to ~/Library/Sounds once (by the app shell) and then go by theirs, so the system
 * plays them with the banner and Focus silences them like any other app's. If that fails,
 * the window plays the sound itself.
 */

/** What a desktop notification from the daemon says about its sound (core/notify.ts DesktopNote). */
export interface NoteSound {
  readonly sound: boolean;
  readonly tone?: SoundChoice;
  readonly volume?: number;
}

/** Files known to be in ~/Library/Sounds this session. */
const installed = new Set<string>();

async function install(choice: SoundChoice, volume: number): Promise<string | null> {
  const name = soundFileName(choice, volume);
  const samples = renderChoice(choice, volume, SAMPLE_RATE);
  if (!name || !samples) return null;
  if (installed.has(name)) return name;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('sound_install', { name, wav: Array.from(encodeWav(samples, SAMPLE_RATE)) });
  installed.add(name);
  return name;
}

/**
 * The `sound` to give the native notification (none: silent, or the window plays it, which
 * `fallback` does; call it once the notification is shown).
 */
export async function notificationSound(n: NoteSound): Promise<{ readonly sound?: string; readonly fallback?: () => void }> {
  const tone = playableHere(n.tone ?? (n.sound ? DEFAULT_SOUND : NO_SOUND), keyPlatform() === 'mac');
  const volume = n.volume ?? DEFAULT_VOLUME;
  if (tone.kind === 'none') return {};
  if (tone.kind === 'mac') return { sound: tone.id };
  try {
    const name = await install(tone, volume);
    if (name) return { sound: name };
  } catch {
    // ~/Library/Sounds isn't writable (or the shell is older): play it here instead.
  }
  return { fallback: () => void playSound(tone, volume).catch(() => undefined) };
}

/**
 * Put the chosen sounds in place ahead of the first notification, and remove Beluga's sounds
 * nobody chose any more (after a change in Settings).
 */
export async function syncSounds(prefs: SoundPrefs): Promise<void> {
  if (!inApp()) return;
  const keep = filesInUse(prefs);
  for (const choice of soundsInUse(prefs)) await install(choice, volumeOf(prefs)).catch(() => null);
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('sound_prune', { keep });
  for (const name of [...installed]) if (!keep.includes(name)) installed.delete(name);
}

/** When Settings last played the test's sound (on the click, so it's heard right away). */
let testPlayedAt = Number.NEGATIVE_INFINITY;

/** Play the test notification's sound in the window (see test-sound.ts). `clicked`: from Settings. */
export function playTestSound(n: NoteSound, clicked = false): void {
  const now = Date.now();
  const tone = testTone(n, clicked, now, testPlayedAt);
  if (clicked) testPlayedAt = now;
  if (tone) void playSound(tone, n.volume ?? DEFAULT_VOLUME).catch(() => undefined);
}
