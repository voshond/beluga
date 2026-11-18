import { z } from 'zod';
import { PROJECT_MEMORY_MAX } from '../shared/memory.js';

/**
 * Beluga's memory in the API (BLG-95): about you, and one per project. The Mac reads and edits it in
 * Settings › Skills & instructions › Memory; the phone only reads it. Browser-safe: zod only.
 */

const scope = z.discriminatedUnion('kind', [z.object({ kind: z.literal('user') }), z.object({ kind: z.literal('project'), root: z.string().min(1).max(4096) })]);
const text = z.string().min(1).max(PROJECT_MEMORY_MAX);
const entry = z.string().min(1).max(40);

export const MEMORY_API = {
  // About you, and every project's (each with its entries, how full it is and its cap) → MemoryOverview.
  'memory.list': { args: z.tuple([]) },
  // Add an entry as you → MemoryView. Refused over the cap or when it looks like a secret.
  'memory.add': { args: z.tuple([scope, text]) },
  // Change an entry's text → MemoryView.
  'memory.replace': { args: z.tuple([scope, entry, text]) },
  // Delete an entry → MemoryView.
  'memory.remove': { args: z.tuple([scope, entry]) },
  // BLG-102: undo a memory write an agent's run made (the marker under its answer: the card's item id, the marker's id) → MemoryView.
  // An add is removed, a replace restored, a remove put back; refused when it was undone already or the entry changed since.
  'memory.undo': { args: z.tuple([z.string().min(1).max(4096), z.string().min(1).max(200), z.string().min(1).max(40)]) },
};
