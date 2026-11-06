import { describe, expect, it } from 'vitest';
import { MAC_SCOPE, dotsOf, doesLine, latestOf, needsOf, scopesOf, sentinelSubtitle, startingPoints } from '../packages/mac/src/sentinel/sentinel-model.js';
import { looksFor, newSourceAsk, sizeFor } from '../packages/mac/src/sentinel/numbers-model.js';
import { snapWidth, tileSentinelOf } from '../src/core/sentinel/dashboard-model.js';
import { CLAUDE_CHANGED, NO_SENTINEL, type Recipe, type RunSummary, type Sentinel, type SentinelState } from '../src/core/sentinel/model.js';

/** Sentinel as one page (BLG-300): what needs you, the dot strip, the project dropdown, what came back, starting points, the board's sizes and looks. */

const at = (h: number, m = 0): number => new Date(2026, 9, 28, h, m).getTime();
const NOW = at(12);

const sentinel = (over: Partial<Sentinel> & Pick<Sentinel, 'id' | 'name'>): Sentinel => ({
  icon: 'calendar',
  trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' },
  steps: [],
  access: 'look',
  limits: { minutes: 30, pauseAfter: 3 },
  notify: 'mac',
  paused: false,
  failures: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const run = (over: Partial<RunSummary> & Pick<RunSummary, 'id' | 'sentinelId'>): RunSummary => ({
  by: 'schedule',
  trigger: { kind: 'schedule', summary: 'Every day at 7:00' },
  state: 'done',
  startedAt: at(7),
  endedAt: at(7, 2),
  headline: '3 commits landed',
  steps: [],
  tasks: [],
  ...over,
});

const brief = sentinel({ id: 'sn_brief', name: 'Morning brief', projectId: 'api', steps: [{ id: 'a', kind: 'claude', name: 'Read what changed', prompt: 'Brief', where: 'project' }, { id: 'b', kind: 'notify', name: 'Tell me', phone: true }] });
const fix = sentinel({ id: 'sn_fix', name: 'Fix what broke', projectId: 'api', trigger: { kind: 'manual' } });
const nightly = sentinel({ id: 'sn_night', name: 'Nightly tests', projectId: 'api', paused: true, pausedWhy: 'Paused after 3 failures in a row', failures: 3 });
const changed = sentinel({ id: 'sn_changed', name: 'Deploy watch', projectId: 'landing', paused: true, pausedWhy: CLAUDE_CHANGED });
const draft = sentinel({ id: 'sn_draft', name: 'Open pull requests', paused: true });
const uptime = sentinel({ id: 'sn_up', name: 'Uptime', projectId: 'landing' });

const runs: RunSummary[] = [
  run({ id: 'r1', sentinelId: 'sn_brief', startedAt: at(7), endedAt: at(7, 2) }),
  run({ id: 'r0', sentinelId: 'sn_brief', startedAt: at(6), endedAt: at(6, 1), state: 'failed', headline: 'CI was down' }),
  run({ id: 'r2', sentinelId: 'sn_fix', state: 'needs-you', startedAt: at(9), endedAt: undefined, pr: { number: 52, url: 'u' }, headline: 'Merge the fix for #48?' }),
  run({ id: 'r3', sentinelId: 'sn_night', state: 'failed', startedAt: at(2), headline: 'exit 1' }),
  run({ id: 'r4', sentinelId: 'sn_up', startedAt: at(11), endedAt: at(11, 1), headline: 'Back after 17 minutes' }),
];

const state = (over: Partial<SentinelState> = {}): SentinelState => ({ ...NO_SENTINEL, enabled: true, items: [brief, fix, nightly, changed, draft, uptime], runs, troubles: { sn_up: 'Sign in to GitHub first' }, ...over });

describe('Sentinel as one page', () => {
  it('what needs you: a merge, then Claude’s change, failures, a trigger that can’t watch, then drafts', () => {
    const needs = needsOf(state());
    expect(needs.map((x) => [x.kind, x.sentinel.id])).toEqual([
      ['merge', 'sn_fix'],
      ['failing', 'sn_night'],
      ['changed', 'sn_changed'],
      ['trouble', 'sn_up'],
      ['draft', 'sn_draft'],
    ]);
    expect(needs[0]!.title).toBe('Fix what broke wants to merge #52');
    // One project's: only its own.
    expect(needsOf(state(), 'landing').map((x) => x.sentinel.id)).toEqual(['sn_changed', 'sn_up']);
    expect(needsOf(state(), MAC_SCOPE).map((x) => x.sentinel.id)).toEqual(['sn_draft']);
  });

  it('a row says what it does in its steps’ names; its recent runs are dots, oldest first', () => {
    expect(doesLine(brief)).toBe('Read what changed → Tell me');
    expect(doesLine(fix)).toBe('No steps yet');
    expect(dotsOf(state(), 'sn_brief', NOW).map((d) => [d.id, d.state])).toEqual([
      ['r0', 'failed'],
      ['r1', 'done'],
    ]);
    expect(dotsOf(state(), 'sn_brief', NOW, 1).map((d) => d.id)).toEqual(['r1']);
  });

  it('the project dropdown lists only projects that have sentinels, in the sidebar’s order, with Your Mac last', () => {
    const projects = [
      { id: 'other', name: 'other' },
      { id: 'landing', name: 'landing' },
      { id: 'api', name: 'bob-api' },
    ];
    expect(scopesOf(state().items, projects).map((x) => [x.value, x.label, x.count])).toEqual([
      [undefined, 'All projects', 6],
      ['landing', 'landing', 2],
      ['api', 'bob-api', 3],
      [MAC_SCOPE, 'Your Mac', 1],
    ]);
  });

  it('what came back: each sentinel’s latest run, newest first, one each', () => {
    const latest = latestOf(state(), undefined);
    expect(latest.map((x) => x.run.id)).toEqual(['r4', 'r2', 'r1', 'r3']);
    expect(latestOf(state(), 'landing').map((x) => x.run.id)).toEqual(['r4']);
  });

  it('the toolbar says how it’s doing, or what Sentinel is when there’s nothing yet', () => {
    expect(sentinelSubtitle({ ...NO_SENTINEL, enabled: true })).toBe('Things Beluga keeps an eye on for you');
    expect(sentinelSubtitle(state())).toMatch(/· 5 need you$/);
  });

  it('starting points come grouped by what you get, a few in each', () => {
    const r = (id: string): Recipe => ({ id, name: id, icon: 'clock', line: '', sentinel: { name: id } });
    const groups = startingPoints(['morning-brief', 'fix-what-broke', 'site-speed', 'uptime-guard'].map(r), 1);
    expect(groups.map((g) => [g.label, g.recipes.map((x) => x.id)])).toEqual([
      ['Tell me', ['morning-brief']],
      ['Fix it', ['fix-what-broke']],
      ['Keep a number', ['site-speed']],
    ]);
  });
});

describe('the board', () => {
  it('a corner dragged across the columns lands on a width there is', () => {
    expect([0.3, 1.4, 1.6, 2.6, 3.4, 4.9, 5.2, 9].map(snapWidth)).toEqual([1, 1, 2, 3, 3, 4, 6, 6]);
  });

  it('a tile knows its sentinel; a thing kept shows in the looks that fit it, at a size that suits', () => {
    expect(tileSentinelOf({ metric: { sentinelId: 'a', metric: 'm' } })).toBe('a');
    expect(tileSentinelOf({ metrics: [{ sentinelId: 'b', metric: 'm' }] })).toBe('b');
    expect(tileSentinelOf({ step: { sentinelId: 'c', stepId: 's' } })).toBe('c');
    expect(tileSentinelOf({})).toBeUndefined();
    expect(looksFor('number')).toEqual(['number', 'line', 'bars']);
    expect(looksFor('series')).toEqual(['line', 'bars']);
    expect(looksFor('rows')).toEqual(['table']);
    expect(looksFor('step')).toEqual(['text']);
    expect([sizeFor('number'), sizeFor('line'), sizeFor('text')]).toEqual(['small', 'half', 'big']);
    expect(newSourceAsk('github', ' Open pull requests ')).toBe('Add a tile from GitHub: Open pull requests. If no sentinel fetches it yet, set one up (a draft) that does.');
  });
});
