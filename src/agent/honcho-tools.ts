import { z } from 'zod';
import { HONCHO_REASONING } from '../shared/honcho.js';
import { tool, toolSuite } from './tool-kit.js';
import type { HonchoTools } from './types.js';

/** Honcho's model of the user as a tool (server `beluga_honcho`, BLG-101): your own runs, on every runtime, with Honcho on. */

export const HONCHO_TOOL_NAMES = ['mcp__beluga_honcho__honcho_ask'];

export function createHonchoToolDefs(honcho: HonchoTools) {
  return [
    tool(
      'honcho_ask',
      'Ask Honcho a question about the person you work for ("how do they like commit messages?") and get a short answer from what it inferred of their earlier conversations. Slow (seconds to a minute). Inferred, so Beluga’s memory and what they say now come first.',
      {
        question: z.string().trim().min(3).max(2000).describe('One question about the user, in plain words'),
        reasoning: z.enum(HONCHO_REASONING).optional().describe('How hard Honcho thinks: "low" (default) is enough for most questions; higher is slower'),
      },
      async (a) => {
        try {
          return { content: [{ type: 'text' as const, text: await honcho.ask(a.question, a.reasoning ?? 'low') }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    ),
  ];
}

export function createHonchoTools(honcho: HonchoTools) {
  return toolSuite({ name: 'beluga_honcho', version: '0.1.0', tools: createHonchoToolDefs(honcho) });
}
