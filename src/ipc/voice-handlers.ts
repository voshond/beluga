import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../core/session.js';
import { sharedVoice } from '../core/voice.js';
import { ON_MAINS, readPowerSource } from '../core/power-source.js';
import type { Args, Method } from './api.js';

/** What each `voice.*` method does (see voice-api.ts). */

type VoiceMethod = Extract<Method, `voice.${string}`>;
type VoiceHandlers = { readonly [M in VoiceMethod]: (s: Session, ...args: Args<M>) => unknown };

export const VOICE_HANDLERS = {
  'voice.models': () => sharedVoice().status(),
  'voice.load': async () => {
    const power = await readPowerSource().catch(() => ON_MAINS);
    const cores = Math.max(1, os.cpus().length);
    return { cpu: Math.round((os.loadavg()[0]! / cores) * 100) / 100, cores, battery: power.battery || power.lowPower };
  },
  'voice.prepare': (_s, model) => sharedVoice().prepare(model),
  'voice.transcribe': async (_s, wav, a) => {
    const bytes = Buffer.from(wav, 'base64');
    if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF' || bytes.subarray(8, 12).toString('latin1') !== 'WAVE') throw new Error('That isn’t a recording');
    // Only this user can read it, and it goes as soon as it's written down (MacVoice deletes it).
    const dir = path.join(os.tmpdir(), 'beluga-voice');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${randomBytes(9).toString('base64url')}.wav`);
    await writeFile(file, bytes, { mode: 0o600 });
    return sharedVoice().transcribe(file, a);
  },
} satisfies VoiceHandlers;
