import { z } from 'zod';
import { tool, toolSuite } from './tool-kit.js';
import type { CallNotesTools } from './types.js';

/**
 * Call notes as tools (server `beluga_calls`, BLG-715): what was said in calls is looked up when
 * it matters, a page at a time, instead of being pasted into the prompt. Your own runs get every
 * call you were in; an answer in a chat gets only that chat's calls.
 */

export const CALL_NOTES_TOOL_NAMES = ['call_notes_list', 'call_notes_search', 'call_notes_read'];

const call = z.string().min(4).max(16).describe('The call’s id (call_notes_list or a search hit gives it)');

function guarded(fn: () => string): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    return Promise.resolve({ content: [{ type: 'text', text: fn() }] });
  } catch (err) {
    return Promise.resolve({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
  }
}

export function createCallNotesToolDefs(notes: CallNotesTools) {
  return [
    tool('call_notes_list', 'The calls that have notes (each person’s own words, written down on their Mac), newest first: id, where, when, how long, who, how many words.', { limit: z.number().int().min(1).max(100).optional() }, (a) => guarded(() => notes.list(a.limit))),
    tool(
      'call_notes_search',
      'Find where something was said in calls: each hit is the call, the time into it, who said it, and the words around. All the words must appear (any case). Search first, then read around a hit.',
      { query: z.string().min(1).max(200), call: call.optional().describe('Only this call'), limit: z.number().int().min(1).max(100).optional() },
      (a) => guarded(() => notes.search(a.query, a.call, a.limit)),
    ),
    tool(
      'call_notes_read',
      'Read part of a call, in order: "[12:30] bob: …". From a time into it (at: "12:30") or a turn number (from, as the last page says); a page at a time. Speech recognition: expect small mistakes.',
      { call, at: z.union([z.string().max(12), z.number()]).optional().describe('A time into the call ("12:30", "1:02:00") or minutes'), from: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() },
      (a) => guarded(() => notes.read(a.call, { ...(a.at !== undefined ? { at: a.at } : {}), ...(a.from !== undefined ? { from: a.from } : {}), ...(a.limit ? { limit: a.limit } : {}) })),
    ),
  ];
}

export function createCallNotesTools(notes: CallNotesTools, opts: { alwaysLoad?: boolean } = {}) {
  return toolSuite({ name: 'beluga_calls', version: '0.1.0', ...(opts.alwaysLoad ? { alwaysLoad: true } : {}), tools: createCallNotesToolDefs(notes) });
}
