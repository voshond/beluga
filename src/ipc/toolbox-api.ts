import { z } from 'zod';
import { ToolDraftSchema, ToolPatchSchema } from '../workspaces/toolbox.js';

/**
 * Project Toolbox in the API (BLG-75): named, parameterized commands a project saves so the user
 * can run them without an agent. Browser-safe: zod only.
 */

const root = z.string().min(1).max(4096);
const id = z.string().min(1).max(80);
const params = z.record(z.string(), z.string().max(500));

export const TOOLBOX_API = {
  // All tools for a project: personal (from projects.json) + team (from beluga.json) → Tool[].
  'toolbox.list': { args: z.tuple([root]) },
  // Create a new tool (personal by default, team if source: 'team') → Tool.
  'toolbox.create': { args: z.tuple([root, ToolDraftSchema]) },
  // Change a tool's name, command, params or source → Tool.
  'toolbox.update': { args: z.tuple([root, id, ToolPatchSchema]) },
  // Delete a tool.
  'toolbox.delete': { args: z.tuple([root, id]) },
  // Run a tool in a terminal tab (without an agent) → terminal key.
  'toolbox.run': { args: z.tuple([root, id, params.optional()]) },
  // Approve a team tool's command (from beluga.json) so it may run. Same flow as approveScript.
  'toolbox.approve': { args: z.tuple([root, id]) },
  // The SSH hosts from ~/.ssh/config, for host-param dropdowns → string[].
  'toolbox.sshHosts': { args: z.tuple([]) },
  // Dismiss a repeated-command NeedsYou suggestion (by its sig id).
  'toolbox.dismissSuggestion': { args: z.tuple([root, z.string().min(1).max(40)]) },
  // Create a tool from an agent's proposal (NeedsYou card "Let Claude make it") → Tool.
  'toolbox.acceptProposal': { args: z.tuple([root, ToolDraftSchema]) },
};
