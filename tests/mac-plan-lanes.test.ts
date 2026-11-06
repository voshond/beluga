import { describe, expect, it } from 'vitest';
import { NO_BOARD } from '../src/core/board/model.js';
import { normalizeBody } from '../src/core/plans/edit.js';
import type { Plan } from '../src/core/plans/model.js';
import { planView } from '../src/core/plans/progress.js';
import { LANE, PLAN_GAPS, placeInLanes } from '../packages/mac/src/plans/plan-layout.js';
import { repoProgress } from '../packages/mac/src/plans/plans-model.js';

const size = (width: number, height: number) => ({ width, height });

describe('a plan across repos in lanes on the canvas (BLG-33)', () => {
  const sizes = new Map([
    ['contract', size(200, 100)],
    ['hooks', size(160, 80)],
    ['ui', size(240, 120)],
    ['ui2', size(100, 60)],
  ]);
  const laneOf = new Map([
    ['contract', 'cal'],
    ['hooks', 'api'],
    ['ui', 'desk'],
    ['ui2', 'desk'],
  ]);

  it('one column per repo in the plan’s order, rows kept across lanes', () => {
    const { boxes, lanes } = placeInLanes([['contract', 'hooks'], ['ui', 'ui2']], sizes, laneOf, ['api', 'cal', 'desk', 'empty']);
    expect(lanes.map((l) => l.id)).toEqual(['api', 'cal', 'desk']);
    const top = PLAN_GAPS.pad + LANE.head;
    expect(boxes.get('hooks')!.y).toBe(top);
    expect(boxes.get('contract')!.y).toBe(top);
    expect(boxes.get('ui')!.y).toBe(top + 100 + PLAN_GAPS.row);
    expect(boxes.get('hooks')!.x).toBeLessThan(boxes.get('contract')!.x);
    expect(boxes.get('contract')!.x).toBeLessThan(boxes.get('ui')!.x);
  });

  it('two milestones of one repo in one row sit side by side in its lane, inside it', () => {
    const { boxes, lanes } = placeInLanes([['ui', 'ui2']], sizes, laneOf, ['desk']);
    const ui = boxes.get('ui')!;
    const ui2 = boxes.get('ui2')!;
    expect(ui2.x).toBe(ui.x + ui.width + PLAN_GAPS.side);
    const lane = lanes[0]!;
    expect(lane.x).toBeLessThanOrEqual(ui.x);
    expect(lane.x + lane.width).toBeGreaterThanOrEqual(ui2.x + ui2.width);
    expect(lane.y + lane.height).toBeGreaterThanOrEqual(ui.y + ui.height);
  });
});

describe('how far each repo got (BLG-33)', () => {
  const body = normalizeBody(
    {
      title: 'Invites',
      goal: '',
      milestones: [
        { id: 'contract', title: 'API', repos: ['cal'], tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] },
        { id: 'ui', title: 'UI', tasks: [{ id: 'c', title: 'C' }] },
      ],
    },
    [],
    ['desk', 'cal'],
  );
  const plan: Plan = { id: 'p', projectId: 'desk', repos: ['desk', 'cal'], home: 'ws:h', status: 'draft', draft: body, draftRev: 1, autonomy: 'gated', maxParallel: 3, testsAt: 'milestone', paused: false, runs: {}, activity: [], createdAt: 0, updatedAt: 0 };

  it('sums its milestones’ tasks by repo', () => {
    const progress = repoProgress(planView(plan, NO_BOARD));
    expect(progress.get('cal')).toEqual({ done: 0, total: 2 });
    expect(progress.get('desk')).toEqual({ done: 0, total: 1 });
  });

  it('a draft’s added repo counts as its own', () => {
    const drafted: Plan = { ...plan, repos: undefined, draft: { ...body, repoChanges: [{ repo: 'cal', change: 'add', by: 'claude' }] } };
    expect([...repoProgress(planView(drafted, NO_BOARD)).keys()].sort()).toEqual(['cal', 'desk']);
  });
});
