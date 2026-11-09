import { describe, expect, it } from 'vitest';
import type { MachineView } from '../src/machines/machines.js';
import { BEST, HERE, REMEMBERED_PICKS, holdReason, rememberPick, runsOnName, runsOnRows, startingPick, statusLine, whyNot } from '../packages/mac/src/machines/runs-on-model.js';

/**
 * Runs on (BLG-786): the rows of its menu, why a computer can't take the work, the one plain line
 * for one that can, and where a project's new work starts.
 */

const NOW = new Date(2026, 10, 8, 14, 0).getTime();
const HOUR = 3_600_000;

function computer(over: Partial<MachineView> & { id: string; name: string }, info: Partial<NonNullable<MachineView['info']>> = {}): MachineView {
  return {
    platform: 'linux',
    version: '0.6.2',
    pairedAt: NOW - 24 * HOUR,
    status: 'online',
    skew: 'same',
    kind: 'aws',
    info: {
      at: NOW,
      version: '0.6.2',
      ipc: 1,
      cpus: 8,
      loadPerCore: 0.3,
      memory: { freeGB: 12.4, totalGB: 32 },
      agentsRunning: 1,
      runtimes: [
        { id: 'claude', state: 'ready' },
        { id: 'codex', state: 'signed_out' },
      ],
      gh: 'signed_in',
      mcp: [],
      projects: [],
      ...info,
    },
    ...over,
  } as MachineView;
}

const box = computer({ id: 'a'.repeat(16), name: 'build-box' });

describe('why a computer can’t take the work', () => {
  it.each([
    ['online and signed in', box, 'claude', undefined],
    ['the runtime signed out there', box, 'codex', 'Codex isn’t signed in there'],
    ['the runtime not there at all', box, 'gemini', 'Gemini isn’t set up there'],
    ['offline, with when it was last seen', computer({ id: 'b'.repeat(16), name: 'pi', status: 'offline', lastSeen: new Date(2026, 10, 8, 13, 2).getTime() }), 'claude', 'Offline since 13:02'],
    ['offline, never seen', computer({ id: 'b'.repeat(16), name: 'pi', status: 'offline' }), 'claude', 'Offline'],
    ['not reached yet', computer({ id: 'b'.repeat(16), name: 'pi', status: 'unknown' }), 'claude', 'Not reached yet'],
    ['on another version', computer({ id: 'b'.repeat(16), name: 'pi', readOnly: true }), 'claude', 'On another version: update it in Settings'],
    [
      'its plan limit reached',
      computer({ id: 'c'.repeat(16), name: 'mini' }, { runtimes: [{ id: 'claude', state: 'ready', usage: { fiveHour: { pct: 100, resetsAt: new Date(2026, 10, 8, 16, 0).getTime() }, updatedAt: NOW } }] }),
      'claude',
      'Claude’s limit resets at 16:00',
    ],
    [
      'a limit that has already reset',
      computer({ id: 'c'.repeat(16), name: 'mini' }, { runtimes: [{ id: 'claude', state: 'ready', usage: { fiveHour: { pct: 100, resetsAt: NOW - 1 }, updatedAt: NOW } }] }),
      'claude',
      undefined,
    ],
  ])('%s', (_case, m, runtime, why) => {
    expect(whyNot(m, runtime, NOW)).toBe(why);
  });
});

describe('the menu', () => {
  it('lists This Mac, each computer with its line, and Best Available with which one and why', () => {
    const pi = computer({ id: 'b'.repeat(16), name: 'pi', status: 'offline' });
    const rows = runsOnRows([box, pi], 'claude', 'This Mac', NOW);
    expect(rows.map((r) => r.label)).toEqual(['This Mac', 'build-box', 'pi', 'Best Available']);
    expect(rows[0]).toMatchObject({ value: HERE, line: 'The computer in front of you', disabled: false });
    expect(rows[1]).toMatchObject({ value: box.id, line: 'AWS · 12 GB free · 1 task running', disabled: false });
    expect(rows[2]).toMatchObject({ disabled: true, line: 'Offline' });
    expect(rows[3]!.value).toBe(BEST);
    expect(rows[3]!.line).toMatch(/^Picks the computer with the most room\. .*build-box/);
  });

  it('a row for a runtime that isn’t signed in there can’t be picked', () => {
    const rows = runsOnRows([box], 'codex', 'This Mac', NOW);
    expect(rows[1]).toMatchObject({ disabled: true, line: 'Codex isn’t signed in there' });
  });

  it('says the line plainly without what it has free', () => {
    expect(statusLine(computer({ id: 'd'.repeat(16), name: 'x', kind: 'mac-mini' }, { agentsRunning: 0, memory: { freeGB: 20.6, totalGB: 32 } }))).toBe('Mac mini · 21 GB free');
    expect(statusLine(computer({ id: 'd'.repeat(16), name: 'x' }, { agentsRunning: 3 }))).toBe('AWS · 12 GB free · 3 tasks running');
  });

  it('names the pick', () => {
    expect(runsOnName(HERE, [box], 'This Mac')).toBe('This Mac');
    expect(runsOnName(BEST, [box], 'This Mac')).toBe('Best Available');
    expect(runsOnName(box.id, [box], 'This Mac')).toBe('build-box');
  });
});

describe('where a project’s new work starts', () => {
  it.each([
    ['nothing picked there: Run New Work On', undefined, box.id, box.id],
    ['the last pick there', HERE, box.id, HERE],
    ['Best Available', undefined, BEST, BEST],
    ['a computer that’s gone: this Mac', 'e'.repeat(16), HERE, HERE],
  ])('%s', (_case, remembered, runOn, pick) => {
    expect(startingPick(remembered, runOn, [box])).toBe(pick);
  });

  it('remembers the last pick per project, the newest kept', () => {
    let picks: Record<string, string> = {};
    for (let i = 0; i < REMEMBERED_PICKS + 5; i++) picks = rememberPick(picks, `p${i}`, HERE);
    expect(Object.keys(picks)).toHaveLength(REMEMBERED_PICKS);
    expect(picks.p0).toBeUndefined();
    picks = rememberPick(picks, 'p10', box.id);
    expect(picks.p10).toBe(box.id);
    expect(Object.keys(picks).at(-1)).toBe('p10');
  });
});

describe('nothing starts here when the chip names another computer (BLG-841)', () => {
  const off = computer({ id: 'b'.repeat(16), name: 'pi', status: 'offline' });
  it.each([
    ['the named computer is offline: held, said why', { where: 'here' as const }, off.id, undefined, 'pi can’t take it now (Offline). Nothing was started: pick another computer in Runs on, or wait for it.'],
    ['This Mac picked: goes here', { where: 'here' as const }, HERE, undefined, undefined],
    ['Best Available landing here: goes here', { where: 'here' as const }, BEST, undefined, undefined],
    ['a computer that can take it: goes there', { where: 'computer' as const, machine: box }, box.id, undefined, undefined],
    ['a folder of this Mac sent to a computer: refused', { where: 'computer' as const, machine: box }, box.id, '/Users/k/notes', 'That folder is on This Mac, so build-box can’t use it. Open build-box’s page to start a chat in one of its folders, or pick This Mac in Runs on.'],
  ])('%s', (_case, route, picked, folder, why) => {
    expect(holdReason(route, picked, [box, off], 'claude', 'This Mac', folder, NOW)).toBe(why);
  });
});
