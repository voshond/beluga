import { z } from 'zod';
import { tool, toolSuite } from './tool-kit.js';
import type { MemoryTools } from './types.js';

/** Beluga's memory as tools (server `beluga_memory`, BLG-95): your own runs, on every runtime. */

export const MEMORY_TOOL_NAMES = ['memory_list', 'memory_add', 'memory_replace', 'memory_remove', 'memory_file', 'memory_search'].map((n) => `mcp__beluga_memory__${n}`);

const guarded = async (fn: () => string): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> => {
  try {
    return { content: [{ type: 'text', text: fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
};

const scope = z.enum(['user', 'project']).describe('"user": about the person you work for, in every project. "project": this project only');
const text = z.string().trim().min(1).max(2200);
const entry = z.string().trim().min(1).max(200).describe('The entry’s id (the [abc123] before it), or a piece of its text that only it has');
const filed = z.boolean().describe('true: filed away, given to a run only when it is about it, beyond the cap. false: every run gets it');

export function createMemoryToolDefs(memory: MemoryTools) {
  return [
    tool('memory_list', 'Show Beluga’s memory now: about the user, and this project’s, each entry with its id and how full each is.', {}, () => guarded(() => memory.list())),
    tool(
      'memory_add',
      'Remember one fact for later runs on any runtime: how the user likes to work, a correction they gave, a project gotcha the repo does not record. Short, one fact. Refused when the memory is full (merge, drop or file away entries first) or when it looks like a secret.',
      { scope, text: text.describe('The fact, in one or two sentences'), filed: filed.optional() },
      (a) => guarded(() => memory.add(a.scope, a.text, a.filed)),
    ),
    tool(
      'memory_replace',
      'Rewrite one entry: correct it, or merge several into one (replace one, remove the others) to make room.',
      { scope, entry, text: text.describe('The entry’s new text') },
      (a) => guarded(() => memory.replace(a.scope, a.entry, a.text)),
    ),
    tool('memory_remove', 'Forget one entry that is wrong or no longer true.', { scope, entry }, (a) => guarded(() => memory.remove(a.scope, a.entry))),
    tool(
      'memory_file',
      'File an entry away: out of every run and kept beyond the cap, given to a run only when its request is about it. For what matters only for some work. filed false brings it back into every run.',
      { scope, entry, filed },
      (a) => guarded(() => memory.file(a.scope, a.entry, a.filed)),
    ),
    tool('memory_search', 'Search the memory, filed-away entries included, for what is kept about something: a tool, a machine, a part of the project.', { query: z.string().trim().min(1).max(400).describe('A few words about what you look for') }, (a) =>
      guarded(() => memory.search(a.query)),
    ),
  ];
}

export function createMemoryTools(memory: MemoryTools) {
  return toolSuite({ name: 'beluga_memory', version: '0.1.0', tools: createMemoryToolDefs(memory) });
}
