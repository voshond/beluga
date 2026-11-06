import { type Plan, planRepos } from '../../../../src/core/plans/model.js';
import type { AgentOrigin, CcSession } from '../../../../src/core/claude-code/model.js';
import { worktreeOrigin } from '../../../../src/workspaces/origin.js';
import type { Project } from '../../../../src/workspaces/types.js';
import { isAgentWorktree, subAgentsUnder } from '../claude-code/subagents-model.js';
import { outsideOf } from './outside-model.js';

/**
 * Whether unfolding a project shows anything: its worktrees and chats, worktrees made outside
 * Beluga, or sub-agents its main folder started. Without any,
 * its row has no fold arrow. Pure (tests/mac-project-rows.test.ts).
 */
export function hasRowsInside(p: Project, sessions: readonly CcSession[], origins: readonly AgentOrigin[] = []): boolean {
  const live = p.workspaces.filter((w) => !w.archived);
  if (live.some((w) => w.kind !== 'main' && worktreeOrigin(w) === 'beluga')) return true;
  if (outsideOf(p).some((w) => !isAgentWorktree(w))) return true;
  const main = live.find((w) => w.kind === 'main');
  return Boolean(main && subAgentsUnder(sessions, main.id, origins).length);
}

/**
 * Where a plan's row goes: under the group holding every one of its repos (a plan across repos),
 * else under its primary project (BLG-20).
 */
export function planPlace(plan: Pick<Plan, 'projectId' | 'repos'>, groups: ReadonlyArray<{ readonly name: string; readonly projects: readonly Pick<Project, 'id'>[] }>): { readonly group: string } | { readonly project: string } {
  const repos = planRepos(plan);
  const home = repos.length > 1 ? groups.find((g) => repos.every((r) => g.projects.some((p) => p.id === r))) : undefined;
  return home ? { group: home.name } : { project: plan.projectId };
}
