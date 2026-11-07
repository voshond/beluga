import { describe, expect, it } from 'vitest';
import type { View } from '../src/core/store.js';
import { viewFromHash, viewToHash } from '../packages/mac/src/lib/web-history-model.js';

describe('a browser’s address follows the view', () => {
  const views: readonly View[] = [
    { kind: 'room' },
    { kind: 'overview' },
    { kind: 'workspace', id: 'ws-1', tab: 'review' },
    { kind: 'task', id: 'BLG-12' },
    { kind: 'gh_issue', projectId: 'p1', number: 42 },
    { kind: 'gh_run', projectId: 'p1', runId: 9007 },
    { kind: 'sentinel_run', runId: 'r-1' },
    { kind: 'tasks', projectId: 'p 1&x', worktree: 'w/1' },
    { kind: 'actions', projectId: 'p1', page: 'workflows' },
  ];

  it('writes a readable hash and reads the same view back', () => {
    expect(viewToHash({ kind: 'task', id: 'BLG-12' })).toBe('#/task?id=BLG-12');
    for (const view of views) expect(viewFromHash(viewToHash(view)!)).toEqual(view);
  });

  it('leaves drafts out of the address', () => {
    expect(viewToHash({ kind: 'draft', projectId: 'p1', back: { kind: 'room' } })).toBeUndefined();
    expect(viewFromHash('#/draft?projectId=p1')).toBeUndefined();
  });

  it('refuses what is no view', () => {
    expect(viewFromHash('')).toBeUndefined();
    expect(viewFromHash('#/constructor')).toBeUndefined();
    expect(viewFromHash('#/nope')).toBeUndefined();
    expect(viewFromHash('#/task')).toBeUndefined();
    expect(viewFromHash('#/gh_issue?projectId=p1&number=abc')).toBeUndefined();
    expect(viewFromHash('#/gh_issue?projectId=p1&number=')).toBeUndefined();
    expect(viewFromHash('#/room?kind=task')).toEqual({ kind: 'room' });
  });
});
