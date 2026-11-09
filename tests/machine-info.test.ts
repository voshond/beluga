import { describe, expect, it } from 'vitest';
import { type InfoDeps, MachineInfo, collectInfo } from '../src/machines/info.js';
import { Store, initialState } from '../src/core/store.js';

/** What a computer has free (BLG-778): its load, memory, disk, agents, sign-ins, MCP servers and projects. */

const GB = 1024 ** 3;

function deps(over: Partial<InfoDeps> = {}): InfoDeps {
  const store = new Store(initialState('room'));
  return {
    os: { cpus: () => Array.from({ length: 8 }, () => ({}) as never), loadavg: () => [2, 1, 1], freemem: () => 12.34 * GB, totalmem: () => 32 * GB, homedir: () => '/home/k' },
    state: () => ({
      ...store.getState(),
      projects: [
        { id: 'p1', name: 'beluga', root: '/home/k/beluga', base: 'main', workspaces: [] },
        { id: 'p2', name: 'scratch', root: '/home/k/scratch', base: 'main', workspaces: [] },
      ],
      self: { peerId: 'me', name: 'k', usages: [{ agent: { runtime: 'claude', label: 'Claude' }, plan: 'max', fiveHour: { pct: 42, resetsAt: 1 }, updatedAt: 5 }] } as never,
      log: [
        { type: 'agent', id: 'a', status: 'tool' } as never,
        { type: 'agent', id: 'b', status: 'done' } as never,
        { type: 'agent', id: 'c', status: 'started' } as never,
      ],
    }),
    disk: async () => ({ freeGB: 120.5, totalGB: 500 }),
    runtimes: async () => [
      { id: 'claude', state: 'ready' },
      { id: 'codex', state: 'signed_out' },
    ],
    gh: async () => 'signed_in',
    mcp: () => [
      { name: 'github', from: 'user' },
      { name: 'github', from: 'project' },
      { name: 'linear', from: 'plugin' },
    ],
    origin: async (root) => (root.endsWith('beluga') ? 'git@github.com:kayraucklnc/beluga.git' : undefined),
    now: () => 1000,
    ...over,
  };
}

describe('what a computer has free', () => {
  it('says its load per core, memory, disk, agents, sign-ins, MCP servers and projects with origins', async () => {
    const info = await collectInfo(deps());
    expect(MachineInfo.parse(info)).toEqual(info);
    expect(info).toMatchObject({
      at: 1000,
      cpus: 8,
      loadPerCore: 0.25,
      memory: { freeGB: 12.3, totalGB: 32 },
      disk: { freeGB: 120.5, totalGB: 500 },
      gh: 'signed_in',
      projects: [{ name: 'beluga', origin: 'git@github.com:kayraucklnc/beluga.git' }, { name: 'scratch' }],
      mcp: [
        { name: 'github', from: 'user' },
        { name: 'linear', from: 'plugin' },
      ],
    });
    expect(info.runtimes).toEqual([
      { id: 'claude', state: 'ready', usage: { plan: 'max', fiveHour: { pct: 42, resetsAt: 1 }, updatedAt: 5 } },
      { id: 'codex', state: 'signed_out' },
    ]);
  });

  it('counts only agents still working', async () => {
    expect((await collectInfo(deps())).agentsRunning).toBe(2);
  });

  it('a reader that fails leaves its part out instead of failing the whole answer', async () => {
    const info = await collectInfo(deps({ disk: async () => Promise.reject(new Error('no statfs')), runtimes: async () => Promise.reject(new Error('x')), gh: async () => Promise.reject(new Error('x')), origin: async () => Promise.reject(new Error('x')) }));
    expect(info.disk).toBeUndefined();
    expect(info.runtimes).toEqual([]);
    expect(info.gh).toBe('missing');
    expect(info.projects).toEqual([{ name: 'beluga' }, { name: 'scratch' }]);
  });

  it('carries what kind of computer it is and its region, once known (BLG-782)', async () => {
    expect((await collectInfo(deps())).kind).toBeUndefined();
    const info = await collectInfo(deps({ kind: () => ({ kind: 'aws', region: 'eu-west-1' }) }));
    expect(info).toMatchObject({ kind: 'aws', region: 'eu-west-1' });
    expect(MachineInfo.parse(info).kind).toBe('aws');
  });
});
