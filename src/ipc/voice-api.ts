import { z } from 'zod';
import { VoiceModelId } from '../companion/protocol.js';

/**
 * Speaking instead of typing in the Mac app (BLG-144): the window records, and the daemon writes it
 * down on the Mac's GPU with the phone's own engine (core/voice.ts, one model loaded for both).
 * Browser-safe: zod only.
 */

/** About two minutes of 16 kHz mono 16-bit WAV, as base64. */
const MAX_WAV_B64 = 5_200_000;

export const VOICE_API = {
  // The Mac's voice models, here or coming → VoiceMacView.
  'voice.models': { args: z.tuple([]) },
  // Get one now (it comes in the background) → VoiceMacView.
  'voice.prepare': { args: z.tuple([VoiceModelId]) },
  // The words in a recording (a 16 kHz mono WAV, base64; written to a temporary file, deleted once
  // written down; `prompt`: the words before it, BLG-160) → TranscriptView. A model that isn't here yet starts coming, and this says how far.
  // How busy this Mac is for writing down (BLG-718): its CPU load per core, its cores, whether it's on
  // battery or in Low Power Mode. A call decides with it who writes down whose words.
  'voice.load': { args: z.tuple([]) },
  'voice.transcribe': { args: z.tuple([z.string().min(1).max(MAX_WAV_B64), z.object({ model: VoiceModelId, language: z.string().regex(/^(auto|[a-z]{2,3})$/), prompt: z.string().max(400).optional() }).strict()]) },
} as const;
