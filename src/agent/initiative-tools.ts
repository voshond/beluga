import { z } from 'zod';
import { tool, toolSuite } from './tool-kit.js';
import type { InitiativeReportTools } from './types.js';

/** Your own worktree runs send what the work made to an initiative (server `beluga_initiatives`, core/initiatives/report.ts). */

export const INITIATIVE_TOOL_NAMES = ['mcp__beluga_initiatives__report_to_initiative'];

export function createInitiativeToolDefs(tools: InitiativeReportTools) {
  return [
    tool(
      'report_to_initiative',
      'Send a file this work made (a report, test or validation output, a screenshot as proof, a generated spec) to the initiative it belongs to, which keeps it on its page and in its memory. Its ticket picks the initiative; name one when it is not linked.',
      {
        file: z.string().trim().min(1).max(4096).describe('The file: a path in this worktree, or a full path on this computer'),
        title: z.string().trim().min(1).max(200).describe('A short title, e.g. "veraPDF report for the golden suite"'),
        why: z.string().trim().max(1000).optional().describe('One line on why it matters to the initiative'),
        initiative: z.string().trim().min(1).max(120).optional().describe('The initiative by name, when the worktree is not linked to one by its ticket'),
      },
      async (a) => {
        try {
          return { content: [{ type: 'text' as const, text: await tools.report(a) }] };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
        }
      },
    ),
  ];
}

export function createInitiativeTools(tools: InitiativeReportTools) {
  return toolSuite({ name: 'beluga_initiatives', version: '0.1.0', tools: createInitiativeToolDefs(tools) });
}
