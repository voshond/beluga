import { describe, expect, it } from 'vitest';
import { type Candidate, cantTake, pickComputer } from '../src/shared/placement.js';
import { candidateOf, placeNewWork } from '../src/machines/placement.js';
import { demoMachines } from '../src/machines/demo.js';

/**
 * Best Available (BLG-789): a pure scorer picks the computer with the most room for a task and
 * says what decided it. Never one that's offline or without the runtime signed in.
 */

const base: Candidate = { id: 'a', name: 'alpha', online: true, hasProject: true, canClone: true, runtime: 'ready', freeMemGB: 16, loadPerCore: 0.3, freeDiskGB: 200, agentsRunning: 0, rttMs: 20 };
const c = (over: Partial<Candidate>): Candidate => ({ ...base, ...over });

describe('who can take it', () => {
  it.each([
    ['offline', c({ online: false }), 'offline'],
    ['another version', c({ readOnly: true }), 'on another version'],
    ['runtime signed out', c({ runtime: 'signed_out' }), 'not signed in'],
    ['runtime not set up', c({ runtime: 'missing' }), 'not set up'],
    ['plan at its limit', c({ runtime: 'limited' }), 'at its plan’s limit'],
    ['no project and can’t clone it', c({ hasProject: false, canClone: false }), 'can’t get the project'],
    ['nearly out of disk', c({ freeDiskGB: 2 }), 'nearly out of disk'],
    ['ready', c({}), undefined],
    ['no project but can clone it', c({ hasProject: false }), undefined],
  ])('%s', (_case, cand, why) => {
    expect(cantTake(cand)).toBe(why);
  });
});

describe('the pick and its reason', () => {
  it.each([
    ['none paired', [], undefined, 'You have no computers paired.'],
    ['none can take it', [c({ online: false }), c({ id: 'b', name: 'beta', runtime: 'signed_out' })], undefined, 'None of your computers can take it: alpha is offline, beta is not signed in.'],
    ['one computer', [c({})], 'a', 'alpha is your only computer.'],
    ['one of two can', [c({}), c({ id: 'b', name: 'beta', online: false })], 'a', 'alpha is the only one that can take it.'],
    ['most free memory decides', [c({ freeMemGB: 8 }), c({ id: 'b', name: 'beta', freeMemGB: 30 })], 'b', 'beta has the most free memory (30 GB).'],
    ['least busy decides', [c({ loadPerCore: 0.9 }), c({ id: 'b', name: 'beta', loadPerCore: 0.1 })], 'b', 'beta has the least busy CPU (10%).'],
    ['fewest tasks decides', [c({ agentsRunning: 3 }), c({ id: 'b', name: 'beta', agentsRunning: 0 })], 'b', 'beta has no tasks running.'],
    ['the quickest link decides', [c({ rttMs: 280 }), c({ id: 'b', name: 'beta', rttMs: 15 })], 'b', 'beta has the quickest link (15 ms).'],
    ['a tie goes to the one with the project', [c({ hasProject: false }), c({ id: 'b', name: 'beta' })], 'b', 'beta and alpha have as much room; beta has the project already.'],
    ['a tie otherwise by name, the same each time', [c({ id: 'z', name: 'zeta' }), c({})], 'a', 'alpha and zeta have as much room; alpha it is.'],
    ['never the offline one, however much room', [c({ freeMemGB: 4 }), c({ id: 'b', name: 'beta', online: false, freeMemGB: 64, loadPerCore: 0 })], 'a', 'alpha is the only one that can take it.'],
    ['never one without the runtime signed in', [c({ loadPerCore: 0.8 }), c({ id: 'b', name: 'beta', runtime: 'signed_out', loadPerCore: 0 })], 'a', 'alpha is the only one that can take it.'],
  ])('%s', (_case, cands, id, why) => {
    const placed = pickComputer(cands);
    expect(placed.id).toBe(id);
    expect(placed.why).toBe(why);
  });

  it('ranks every one that can take it, best first', () => {
    const placed = pickComputer([c({ loadPerCore: 0.9 }), c({ id: 'b', name: 'beta', loadPerCore: 0.1 }), c({ id: 'x', name: 'x', online: false })]);
    expect(placed.ranked.map((r) => r.id)).toEqual(['b', 'a']);
    expect(placed.factor).toBe('load');
  });
});

describe('your computers as it weighs them', () => {
  const [mini, aws] = demoMachines({ projects: [] }, Date.now());

  it('reads what each has free, and its runtime there', () => {
    expect(candidateOf(aws!, 'codex').runtime).toBe('signed_out');
    expect(candidateOf(aws!, 'claude')).toMatchObject({ online: true, runtime: 'ready', hasProject: true });
    expect(candidateOf(mini!, 'claude', 'git@github.com:kayraucklnc/landing.git').hasProject).toBe(true);
    expect(candidateOf(aws!, 'claude', 'git@github.com:kayraucklnc/landing.git').hasProject).toBe(false);
  });

  it('Best Available in Run New Work On says which and why; a Codex task never goes where Codex isn’t signed in', () => {
    const placed = placeNewWork('best', [mini!, aws!], { name: 'This Mac' });
    expect(placed).toMatchObject({ where: 'computer', id: mini!.id });
    expect(placed.why).toMatch(/^Mac mini at home has /);
    expect(placeNewWork('best', [aws!], { name: 'This Mac' }, { runtime: 'codex' })).toMatchObject({ where: 'here' });
  });
});
