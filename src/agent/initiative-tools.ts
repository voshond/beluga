import { z } from 'zod';
import { tool, toolSuite } from './tool-kit.js';
import { QuestionIdSchema } from '../core/initiatives/questions.js';
import type { InitiativeQuestionTools, InitiativeReportTools } from './types.js';

/** Your own worktree runs send what the work made to an initiative (server `beluga_initiatives`, core/initiatives/report.ts). */

export const INITIATIVE_TOOL_NAMES = ['mcp__beluga_initiatives__report_to_initiative', 'mcp__beluga_initiatives__track_question'];

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

export const createInitiativeQuestionTools = (tools: InitiativeQuestionTools) => toolSuite({
  name: 'beluga_initiatives',
  version: '0.1.0',
  tools: [tool(
    'track_question',
    'Get the stable ID of a question in this initiative or record a new one. Reuse an existing question for the same ask. Attach the returned ID as "question" when drafting Slack or Jira outreach. This does not send anything.',
    {
      id: QuestionIdSchema.optional().describe('The ID of an existing question, if known'),
      text: z.string().trim().min(1).max(4000).optional().describe('The question, required when the ID is omitted'),
      waitingOn: z.string().trim().max(120).optional().describe('Who can answer, by directory name'),
    },
    async (input) => {
      try {
        const result = await tools.track(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  )],
});
