import type { SoundChoice } from '../../../../../src/shared/notify-sound.js';
import { inApp } from '../boot.js';
import { keyPlatform } from '../shortcuts-model.js';
import { playableHere, renderChoice } from './catalog.js';

/**
 * Playing a sound in the window: the ▶ previews in Settings, and the fallback when a
 * notification's sound couldn't be handed to macOS. Mac sounds are played by the app shell
 * (the window can't read /System/Library/Sounds).
 */

let context: AudioContext | undefined;
let playing: AudioBufferSourceNode | undefined;

function audio(): AudioContext | undefined {
  if (typeof AudioContext === 'undefined') return undefined;
  context ??= new AudioContext();
  return context;
}

/** Play it now (stopping the previous preview). Resolves once it has started. */
export async function playSound(picked: SoundChoice, volume: number): Promise<void> {
  const choice = playableHere(picked, keyPlatform() === 'mac');
  if (choice.kind === 'none') return;
  if (choice.kind === 'mac') {
    if (!inApp()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('sound_play_system', { name: choice.id });
    return;
  }
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === 'suspended') await ctx.resume();
  const samples = renderChoice(choice, volume, ctx.sampleRate);
  if (!samples) return;
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  playing?.stop();
  playing = source;
  source.onended = () => {
    if (playing === source) playing = undefined;
  };
  source.start();
}
