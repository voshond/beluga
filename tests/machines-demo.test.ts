import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDemoWorkspaces } from '../src/demo.js';
import { demoMachines } from '../src/machines/demo.js';
import { MachineInfo, runningWork } from '../src/machines/info.js';

/** The demo's computers (BLG-779): a Mac mini at home (Always On) and build-box (an AWS server) running a demo worktree. */

describe('the demo’s computers', () => {
  it('lists two machines with load figures that stay believable over time', () => {
    const t = 1_762_600_000_000;
    for (const now of [t, t + 17_000, t + 45_000, t + 3_600_000, Date.now()]) {
      const machines = demoMachines({ projects: [] }, now);
      expect(machines.map((m) => [m.name, m.platform, m.status])).toEqual([
        ['Mac mini at home', 'macos', 'online'],
        ['build-box', 'linux', 'online'],
      ]);
      for (const m of machines) {
        expect(m.id).toMatch(/^[0-9a-f]{16}$/);
        const info = MachineInfo.parse(m.info);
        expect(info.loadPerCore).toBeGreaterThan(0);
        expect(info.loadPerCore).toBeLessThan(1);
        expect(info.memory.freeGB).toBeLessThan(info.memory.totalGB);
        expect(m.rttMs).toBeGreaterThan(0);
      }
      expect(machines[0]!.alwaysOn).toBe(true);
      expect(machines[1]!.alwaysOn).toBeUndefined();
    }
  });

  it('the build-box runs one of the demo’s own worktrees, so it opens and streams as a local one', async () => {
    const mgr = await createDemoWorkspaces();
    const [, aws] = demoMachines({ projects: mgr.list });
    const work = aws!.info!.work!;
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ project: 'bob-api', worktree: 'webhook-retries' });
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => `ws:${w.id}` === work[0]!.channel);
    expect(ws && existsSync(ws.path)).toBe(true);
    expect(aws!.info!.agentsRunning).toBe(1);
  }, 60_000);

  it('a real computer says which worktrees have a run going', () => {
    const projects = [{ id: 'p', name: 'api', root: '/r', base: 'main', workspaces: [{ id: 'w1', name: 'one' }, { id: 'w2', name: 'two' }] }] as never;
    const log = [{ type: 'agent', channel: 'ws:w2', status: 'tool' }, { type: 'agent', channel: 'ws:w1', status: 'done' }] as never;
    expect(runningWork({ projects, log })).toEqual([{ project: 'api', worktree: 'two', channel: 'ws:w2' }]);
  });
});
