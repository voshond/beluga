import type { Workspace } from '../../../../src/workspaces/types.js';
import { isAgentWorktree } from '../claude-code/subagents-model.js';

/** A worktree or chat of yours the look back reads (BLG-108): not a sub-agent's worktree, a thread, or one shared with friends. */
export const lookBackOffered = (ws: Workspace, sharedWithSomeone: boolean): boolean => !isAgentWorktree(ws) && !ws.thread && !ws.purpose && !sharedWithSomeone;
