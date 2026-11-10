import { z } from 'zod';
import { tool, toolSuite } from './tool-kit.js';
import { ToolDraftSchema } from '../workspaces/toolbox.js';

/**
 * Project Toolbox as Claude's tools (server `beluga_tools`, BLG-75): list, run and propose tools.
 * Available in your own runs; tool_propose creates a personal tool behind a Keep/Discard card.
 */

export const TOOLBOX_TOOL_NAMES = ['tool_list', 'tool_run', 'tool_propose'].map((n) => `mcp__beluga_tools__${n}`);

async function guarded(fn: () => string | Promise<string>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

export interface ToolboxTools {
  /** List all Toolbox tools for the current project → one per line: name, command, source. */
  list(projectRoot?: string): string;
  /**
   * Run a tool by name or id, with optional param values → terminal key. The user sees the output
   * in a Terminal tab; this returns the key so you can tell them where to look.
   */
  run(nameOrId: string, params?: Readonly<Record<string, string>>, projectRoot?: string): string | Promise<string>;
  /**
   * Propose a new personal tool (createdBy: 'claude'): it appears as a NeedsYou card ("Keep /
   * Discard") and is saved only when the user keeps it. Never call without explicit user intent.
   */
  propose(draft: { name: string; command: string; params?: Array<{ name: string; kind: 'host' | 'text' }>; projectRoot?: string; replaces?: string }): string | Promise<string>;
}

export function createToolboxToolDefs(toolbox: ToolboxTools) {
  return [
    tool(
      'tool_list',
      "List this project's Toolbox tools: name, command (with its {{params}}), and source (personal or team). Use it before tool_run to find the right name.",
      { project_root: z.string().max(4096).optional().describe("The project root to list tools for; leave out for the current worktree's project") },
      (a) => guarded(() => toolbox.list(a.project_root)),
    ),
    tool(
      'tool_run',
      "Run a Toolbox tool by its name (from tool_list). It opens in a Terminal tab so the user sees its output live; this call returns the terminal key. Fill any {{params}} by passing them in `params`. Never run a tool that requires user approval (a team tool not yet approved): tell the user to approve it first.",
      {
        name: z.string().min(1).max(100).describe("The tool's name exactly as tool_list shows it"),
        params: z.record(z.string(), z.string().max(500)).optional().describe("Values for the tool's {{params}}, by name"),
        project_root: z.string().max(4096).optional().describe("The project root; leave out for the current worktree's project"),
      },
      (a) => guarded(() => toolbox.run(a.name, a.params, a.project_root)),
    ),
    tool(
      'tool_propose',
      "Propose a new personal Toolbox tool for this project, or a revision of an existing one (pass `replaces`), only when the user explicitly asked for one or agreed to your offer. It appears as a \"Keep / Discard\" card (\"Update / Discard\" for a revision) and is saved only when the user keeps it. Use {{param}} placeholders for values that change between runs.",
      {
        name: z.string().trim().min(1).max(100).describe('Short, action-oriented name ("Deploy to <host>", "Run tests", "Start dev server")'),
        command: z.string().trim().min(1).max(2000).describe('The command to run; use {{param}} placeholders for host names and other varying values'),
        params: z
          .array(z.object({ name: z.string().min(1).max(40), kind: z.enum(['host', 'text'] as const) }))
          .max(10)
          .optional()
          .describe('The params this command takes (kind "host" offers ~/.ssh/config hosts; "text" is free input)'),
        project_root: z.string().max(4096).optional().describe("The project root; leave out for the current worktree's project"),
        replaces: z.string().min(1).max(100).optional().describe('The id (or exact name) of the existing tool this revises, from tool_list; Keep then updates it in place instead of adding a new tool'),
      },
      (a) => guarded(() => toolbox.propose({ name: a.name, command: a.command, ...(a.params ? { params: a.params } : {}), ...(a.project_root ? { projectRoot: a.project_root } : {}), ...(a.replaces ? { replaces: a.replaces } : {}) })),
    ),
  ];
}

export function createToolboxTools(toolbox: ToolboxTools) {
  return toolSuite({ name: 'beluga_tools', version: '0.1.0', tools: createToolboxToolDefs(toolbox) });
}
