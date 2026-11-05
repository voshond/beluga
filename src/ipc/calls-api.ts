import { z } from 'zod';
import { SIGNAL_MAX } from '../shared/calls.js';

/**
 * Calls in a conversation with friends (BLG-706, core/calls): ringing, joining, muting, sharing,
 * and the WebRTC setup the window passes to the others' windows. The media itself never goes
 * through here. Browser-safe: zod only.
 */

const conversation = z.string().regex(/^(dm:[\w-]{32}|group:[0-9a-f]{32}|room)$/);
// Friends' peer ids, or someone's in the room.
const peerId = z.string().regex(/^[\w:+/=.-]{1,200}$/);

export const CALLS_API = {
  // Ring everyone in a conversation (or join the call it has) → CallView.
  'calls.start': { args: z.tuple([conversation]) },
  // Answer, or join the call going on there → CallView. From the phone, your Mac's window picks it up.
  'calls.join': { args: z.tuple([conversation]) },
  'calls.leave': { args: z.tuple([conversation]) },
  // Not now: it stops ringing, and whoever rang hears it.
  'calls.decline': { args: z.tuple([conversation]) },
  // Mute, share or turn your camera on (the window also says this every few seconds, so the daemon knows it's still making the call) → CallView.
  'calls.set': { args: z.tuple([conversation, z.object({ muted: z.boolean().optional(), sharing: z.boolean().optional(), camera: z.boolean().optional(), uplink: z.number().int().min(0).max(10_000_000).optional() }).strict()]) },
  // WebRTC setup for someone's window in the call (an offer, answer or candidate, as JSON) → whether it went.
  'calls.signal': { args: z.tuple([conversation, peerId, z.string().min(1).max(SIGNAL_MAX)]) },
  // Your own words in a call you were in (written down on this Mac, BLG-715): kept here and sent to the
  // others who were in it → how many it reached now.
  'calls.notes': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/), z.array(z.object({ at: z.number().int().min(0), text: z.string().min(1).max(2_000) })).max(3_000)]) },
  // Forget a call's notes on this Mac (the others keep theirs).
  'calls.forgetNotes': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/)]) },
  // The calls in your conversations → CallsView.
  'calls.list': { args: z.tuple([]) },
} as const;
