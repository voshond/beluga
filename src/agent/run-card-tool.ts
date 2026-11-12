import { z } from 'zod';
import { runCard, runCardResult } from '../core/run-ask.js';
import type { ClaudeAnswer, ClaudeQuestion } from '../protocol.js';
import { tool } from './tool-kit.js';

export const RUN_CARD_TOOL = 'mcp__beluga__run_for_me';

/**
 * Commands only the user can run (sudo, a password, another machine), as a card with a Run button
 * (core/run-ask.ts): it waits for them, then answers with what the run printed, their words, or a skip.
 */
export function runCardToolDef(askUser: (question: ClaudeQuestion) => Promise<ClaudeAnswer>) {
  return tool(
    'run_for_me',
    'Put commands the user must run themselves (sudo, a password, a step on another machine) on a card with a Run button. Beluga runs them where you say when they click Run, asks them for any password itself, and this returns the exit code and what it printed (or that they skipped it). Never for commands you can run yourself. One card per machine.',
    {
      why: z.string().min(1).max(400).describe('Why they need to run it, in a sentence or two'),
      on: z.string().max(80).optional().describe('The machine: its SSH Host name ("nas", "arch"). Leave out for this computer'),
      cwd: z.string().max(300).optional().describe('The full path to run them in (becomes a cd before them)'),
      commands: z.array(z.string().min(1).max(500)).min(1).max(20).describe('The commands, one per item, exactly as typed in a shell'),
      expect: z.string().max(200).optional().describe('What they will see when it worked'),
      title: z.string().max(40).optional().describe('The card’s title (default: Run this for me)'),
    },
    async (a) => {
      const question = runCard(a.why, { commands: a.commands, ...(a.on ? { on: a.on } : {}), ...(a.cwd ? { cwd: a.cwd } : {}), ...(a.expect ? { expect: a.expect } : {}) }, a.title);
      if (typeof question === 'string') return { content: [{ type: 'text' as const, text: question }], isError: true };
      return { content: [{ type: 'text' as const, text: runCardResult(await askUser(question)) }] };
    },
  );
}
