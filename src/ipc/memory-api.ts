import { z } from 'zod';
import { PROJECT_MEMORY_MAX } from '../shared/memory.js';

/**
 * Beluga's memory in the API (BLG-95): about you, and one per project. The Mac reads and edits it in
 * Settings › Skills & instructions › Memory; the phone only reads it. Browser-safe: zod only.
 */

const scope = z.discriminatedUnion('kind', [z.object({ kind: z.literal('user') }), z.object({ kind: z.literal('project'), root: z.string().min(1).max(4096) })]);
const text = z.string().min(1).max(PROJECT_MEMORY_MAX);
const entry = z.string().min(1).max(40);
const proposalId = z.string().min(1).max(200);

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
  // BLG-96: Keep (or Update) what the reflection pass proposed to remember → MemoryView. Refused when the entry it changes moved on since.
  'memory.keepProposal': { args: z.tuple([proposalId]) },
  // BLG-96: Discard it: nothing is written, and the same thing is not proposed again.
  'memory.discardProposal': { args: z.tuple([proposalId]) },
  // BLG-96: look back at one of your own conversations now and propose what to remember → { proposed } or { skipped, why }.
  'memory.reflect': { args: z.tuple([z.string().min(1).max(400)]) },
};
