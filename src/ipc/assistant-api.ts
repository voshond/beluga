import { z } from 'zod';
import { CHAT_ID } from '../shared/assistant.js';

/**
 * Your Mac's chats (BLG-102, core/assistant): several at once, tabs on the Mac. Which there are
 * and the one open are in the shared state's `assistant`. Browser-safe: zod only.
 */

const chat = z.string().regex(CHAT_ID);

export const ASSISTANT_API = {
  // A new, empty chat after the others, open now → its id.
  'assistant.newChat': { args: z.tuple([]) },
  // Open one of them (which is open is kept across restarts).
  'assistant.openChat': { args: z.tuple([chat]) },
  // Delete one for good (its run stopped, its messages, its files and its Claude transcript gone; no archive). The last one leaves a fresh chat.
  'assistant.deleteChat': { args: z.tuple([chat]) },
  // Its scratch folder (shared by its chats), for the Mac's Scratch tab → { root, dir, files (newest first), total: { files, bytes }, at } (`at`: the folder as a Location, so its files open in the viewer).
  'assistant.scratch': { args: z.tuple([]) },
} as const;
