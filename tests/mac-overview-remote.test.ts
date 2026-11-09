import { describe, expect, it } from 'vitest';
import { type OverviewItem, narrowThere, needsThere } from '../packages/mac/src/views/overview/overview-model.js';

/**
 * Overview's Needs You covers every computer (BLG-843): what needs you on a computer, from its own
 * Overview items, listed with what it waits on and its page there, narrowed like this Mac's rows.
 */

const project = (name: string, root = `/p/${name}`) => ({ id: `p-${name}`, name, root, workspaces: [] }) as unknown as OverviewItem['project'];
const item = (over: Partial<OverviewItem> & { id: string; name: string }): OverviewItem =>
  ({ ws: { id: over.id, name: over.name, kind: 'worktree' }, project: project('bob-api'), archived: false, needs: false, ready: false, when: 0, rank: 4, ...over }) as unknown as OverviewItem;

describe('what needs you on a computer', () => {
  const items = [
    item({ id: 'w1', name: 'retries', needs: true, rank: 0 }),
    item({ id: 'w2', name: 'flaky', needs: true, rank: 1 }),
    item({ id: 'w3', name: 'idle' }),
    item({ id: 'w4', name: 'old', needs: true, archived: true }),
    item({ id: 'c1', name: 'disk usage', needs: true, rank: 0, project: project('chats', '') }),
    item({ id: 'h1', name: 'checkout', needs: true, rank: 0, plan: { plan: { id: 'pl1' }, title: 'Card checkout', unread: 0, tip: '2 approvals' } as unknown as NonNullable<OverviewItem['plan']> }),
  ];

  it('lists only what needs you and isn’t archived, with what it waits on and its page there', () => {
    expect(needsThere(items)).toEqual([
      { id: 'w1', title: 'retries', project: 'bob-api', why: 'Waiting for you', page: { kind: 'workspace', id: 'w1', tab: 'chat' } },
      { id: 'w2', title: 'flaky', project: 'bob-api', why: 'Checks failing', page: { kind: 'workspace', id: 'w2', tab: 'chat' } },
      { id: 'c1', title: 'disk usage', project: 'Chats', why: 'Waiting for you', page: { kind: 'workspace', id: 'c1', tab: 'chat' } },
      { id: 'h1', title: 'Card checkout', project: 'bob-api', why: '2 approvals', page: { kind: 'plan', id: 'pl1' } },
    ]);
  });

  it('narrows like this Mac’s rows: the project by name, every word of the search', () => {
    const rows = needsThere(items);
    expect(narrowThere(rows, 'bob-api', '').map((r) => r.id)).toEqual(['w1', 'w2', 'h1']);
    expect(narrowThere(rows, undefined, 'card check').map((r) => r.id)).toEqual(['h1']);
    expect(narrowThere(rows, 'landing', '')).toEqual([]);
  });
});
