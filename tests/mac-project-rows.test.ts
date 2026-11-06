import { describe, expect, it } from 'vitest';
import type { CcAgent, CcSession } from '../src/core/claude-code/model.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { hasRowsInside, planPlace } from '../packages/mac/src/layout/project-rows.js';

/** A project's fold arrow shows only when unfolding it would show something. */
describe('what a project has inside', () => {
  const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, projectRoot: '/r', name: id, path: `/r/${id}`, kind: 'worktree', createdAt: 0, projectId: 'p', external: false, ...over });
  const main = ws('main', { kind: 'main', path: '/r' });
  const project = (...workspaces: Workspace[]): Project => ({ id: 'p', name: 'p', root: '/r', base: 'main', workspaces: [main, ...workspaces] });
  const agent = (id: string, extra: Partial<CcAgent> = {}): CcAgent => ({ id, description: id, type: 'general-purpose', background: true, status: 'finished', startedAt: 1, lastAt: 2, steps: 1, ...extra });
  const session = (agents: CcAgent[], workspaceId: string): CcSession => ({ id: 's', title: 's', cwd: '/r', status: 'idle', lastAt: 1, steps: 1, agents, own: true, workspaceId });

  it('nothing: just the main folder, or only archived work', () => {
    expect(hasRowsInside(project(), [])).toBe(false);
    expect(hasRowsInside(project(ws('old', { archived: true })), [])).toBe(false);
  });

  it('its worktrees and chats, worktrees made outside Beluga', () => {
    expect(hasRowsInside(project(ws('feature')), [])).toBe(true);
    expect(hasRowsInside(project(ws('chat', { kind: 'chat' as Workspace['kind'] })), [])).toBe(true);
    expect(hasRowsInside(project(ws('theirs', { external: true, path: '/elsewhere/theirs' })), [])).toBe(true);
  });

  it('sub-agents started in the main folder; an old sub-agent worktree on its own is nothing to show', () => {
    expect(hasRowsInside(project(), [session([agent('a1')], 'main')])).toBe(true);
    expect(hasRowsInside(project(ws('agent-x', { external: true, path: '/r/.claude/worktrees/agent-x' })), [])).toBe(false);
  });
});

describe('where a plan’s row goes (BLG-20)', () => {
  const groups = [
    { name: 'Calendar', projects: [{ id: 'api' }, { id: 'cal' }, { id: 'desk' }] },
    { name: 'Other', projects: [{ id: 'web' }] },
  ];

  it('a one-repo plan: under its project, even in a group', () => {
    expect(planPlace({ projectId: 'api' }, groups)).toEqual({ project: 'api' });
    expect(planPlace({ projectId: 'api', repos: ['api'] }, groups)).toEqual({ project: 'api' });
  });

  it('a plan across repos all in one group: under the group', () => {
    expect(planPlace({ projectId: 'cal', repos: ['cal', 'api', 'desk'] }, groups)).toEqual({ group: 'Calendar' });
  });

  it('its repos in different groups, or one not in any: under its primary', () => {
    expect(planPlace({ projectId: 'api', repos: ['api', 'web'] }, groups)).toEqual({ project: 'api' });
    expect(planPlace({ projectId: 'api', repos: ['api', 'loose'] }, groups)).toEqual({ project: 'api' });
    expect(planPlace({ projectId: 'api', repos: ['api', 'cal'] }, [])).toEqual({ project: 'api' });
  });
});
