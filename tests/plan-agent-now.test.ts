import { describe, expect, it } from 'vitest';
import type { BoardState, Issue } from '../src/core/board/model.js';
import { normalizeBody } from '../src/core/plans/edit.js';
import type { Plan } from '../src/core/plans/model.js';
import { type Live, NOBODY_LIVE, agentNowWords, planView } from '../src/core/plans/progress.js';
import { milestoneNowWords } from '../packages/mac/src/plans/plans-model.js';

/** BLG-688: a milestone's agent at work shows on the plan, even between tasks when no card is lit. */

const body = normalizeBody({
  title: 'Serve it',
  goal: 'g',
  milestones: [
    {
      id: 'docs',
      title: 'README and guide',
      criteria: ['works'],
      tasks: [
        { id: 'readme', title: 'README' },
        { id: 'guide', title: 'Guide' },
        { id: 'vm', title: 'Walk the docs on a VM', blockedBy: ['readme', 'guide'] },
      ],
    },
  ],
});
const withIssues = (b: typeof body): typeof body => ({ ...b, milestones: b.milestones.map((m) => ({ ...m, tasks: m.tasks.map((t) => ({ ...t, issueId: `i-${t.id}` })) })) });
const issue = (id: string, key: string, status: Issue['status'], worktrees: string[] = []): Issue => ({ id: `i-${id}`, key, title: id, status, worktrees, blockedBy: [], brief: {} }) as unknown as Issue;
const board = (issues: Issue[]): BoardState => ({ enabled: true, issues, projects: {}, autoTasks: false });
const plan = (): Plan => ({ id: 'p', projectId: 'x', home: 'ws:h', status: 'active', body: withIssues(body), draftRev: 1, autonomy: 'gated', maxParallel: 3, testsAt: 'milestone', paused: false, runs: { docs: { agent: { worktree: 'w1', at: 100, tasks: ['readme', 'guide', 'vm'] } } }, activity: [], createdAt: 0, updatedAt: 0 });
const busyIn = (channel: string, step?: string): Live => ({
  busy: (c) => c === channel,
  asking: () => false,
  run: (c) => (c === channel ? { requestId: 'r', status: 'started', ts: 1000, lastAt: 2000, text: '', ...(step ? { step, stepAt: 2000 } : {}) } : undefined),
});

describe('a milestone’s agent, right now', () => {
  // Two tasks in review, the last one not started: its agent is between them.
  const between = board([issue('readme', 'BLG-660', 'in_review', ['w1']), issue('guide', 'BLG-661', 'in_review', ['w1']), issue('vm', 'BLG-662', 'todo')]);

  it('at work between tasks: the milestone says so, though no card is running', () => {
    const m = planView(plan(), between, busyIn('ws:w1', 'Read docs/headless.md')).milestones[0]!;
    expect(m.state).toBe('running');
    expect(m.tasks.some((t) => t.state === 'running')).toBe(false);
    expect(m.agentNow?.kind).toBe('working');
    const w = agentNowWords(m, 0)!;
    expect(w.label).toBe('Working between tasks');
    expect(w.sub).toContain('docs/headless.md');
    expect(w.onCard).toBe(false);
    expect(milestoneNowWords(m, 2000)).toMatchObject({ label: 'Working between tasks', tone: 'claude' });
  });

  it('on a task: it names it (the card says the step)', () => {
    const on = board([issue('readme', 'BLG-660', 'in_review', ['w1']), issue('guide', 'BLG-661', 'in_progress', ['w1']), issue('vm', 'BLG-662', 'todo')]);
    const m = planView(plan(), on, busyIn('ws:w1')).milestones[0]!;
    expect(agentNowWords(m, 0)).toMatchObject({ label: 'Working on BLG-661', onCard: true, asking: false });
  });

  it('asking you: says so, in a warning tone', () => {
    const live: Live = { busy: () => false, asking: (c) => c === 'ws:w1' };
    const m = planView(plan(), between, live).milestones[0]!;
    expect(milestoneNowWords(m, 0)).toMatchObject({ label: 'Asked you something', tone: 'warn' });
  });

  it('busy before its first word: working, timed from when it started (never from 0)', () => {
    const live: Live = { busy: (c) => c === 'ws:w1', asking: () => false };
    const m = planView(plan(), between, live).milestones[0]!;
    expect(m.agentNow).toEqual({ kind: 'working', since: 100 });
  });

  it('between turns, or with no agent, it says nothing (its tasks say how they are)', () => {
    expect(planView(plan(), between, NOBODY_LIVE).milestones[0]!.agentNow).toBeUndefined();
    expect(planView(plan(), between, busyIn('ws:other')).milestones[0]!.agentNow).toBeUndefined();
    const none = { ...plan(), runs: {} } as Plan;
    expect(planView(none, between, busyIn('ws:w1')).milestones[0]!.agentNow).toBeUndefined();
  });
});
