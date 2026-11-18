import { describe, expect, it } from 'vitest';
import { lookBackOffered } from '../packages/mac/src/lib/look-back-model.js';
import type { Workspace } from '../src/workspaces/types.js';

const ws = (more: Partial<Workspace> = {}): Workspace => ({ id: 'a', projectId: 'p1', projectRoot: '/code/app', name: 'a', path: '/wt/a', kind: 'worktree', branch: 'beluga/a', createdAt: 0, external: false, ...more });

describe('where Look Back is offered (BLG-108)', () => {
  it('on worktrees, chats and the main worktree of yours', () => {
    expect(lookBackOffered(ws(), false)).toBe(true);
    expect(lookBackOffered(ws({ kind: 'chat' }), false)).toBe(true);
    expect(lookBackOffered(ws({ kind: 'main', path: '/code/app' }), false)).toBe(true);
  });

  it('never on a sub-agent’s worktree, a thread or one you share', () => {
    expect(lookBackOffered(ws({ external: true, path: '/code/app/.claude/worktrees/agent-1a2b3c4d' }), false)).toBe(false);
    expect(lookBackOffered(ws({ thread: { parent: 'b' } as Workspace['thread'] }), false)).toBe(false);
    expect(lookBackOffered(ws(), true)).toBe(false);
  });
});
