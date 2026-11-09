import type { DomainState } from '../core/store.js';
import type { MachineInfo } from './info.js';
import type { MachineView } from './machines.js';

/**
 * The demo's computers (BLG-779), for the e2e tests and GIFs: a Mac mini at home that is your
 * Always On, and a server on AWS. Their figures sway a little over time, as real ones do. The AWS
 * server runs one of the demo's own worktrees (bob-api's webhook-retries), so opening it from there
 * streams exactly as a local demo worktree does.
 */

const HOUR = 3_600_000;

/** A gentle wave between `lo` and `hi`, the same at the same time (two decimals). */
const wave = (now: number, lo: number, hi: number, periodMs: number, phase = 0): number => Math.round((lo + ((hi - lo) * (1 + Math.sin((now / periodMs) * 2 * Math.PI + phase))) / 2) * 100) / 100;

const usage = (now: number, fiveHour: number, week: number) => ({ plan: 'max', fiveHour: { pct: fiveHour, resetsAt: now + 2 * HOUR }, week: { pct: week, resetsAt: now + 3 * 24 * HOUR }, updatedAt: now - 60_000 });

/** The demo worktree the build-box runs: bob-api's webhook-retries, by its conversation. */
function awsWork(state: Pick<DomainState, 'projects'>): NonNullable<MachineInfo['work']> {
  const api = state.projects.find((p) => p.name === 'bob-api');
  const ws = api?.workspaces.find((w) => w.name === 'webhook-retries');
  return api && ws ? [{ project: api.name, worktree: ws.name, channel: `ws:${ws.id}` }] : [];
}

/** The demo's Mac mini: its Always On to begin with (BLG-796). */
export const DEMO_ALWAYS_ON = { id: 'de30a1c0ffee0001', name: 'Mac mini at home' } as const;

/** The demo's computers' ids (the demo daemon serves their pages itself). */
const DEMO_IDS: ReadonlySet<string> = new Set([DEMO_ALWAYS_ON.id, 'de30a1c0ffee0002']);
export const isDemoMachine = (id: string): boolean => DEMO_IDS.has(id);

export function demoMachines(state: Pick<DomainState, 'projects'>, now = Date.now()): MachineView[] {
  const origin = (name: string): string => `git@github.com:kayraucklnc/${name}.git`;
  const work = awsWork(state);
  return [
    {
      id: DEMO_ALWAYS_ON.id,
      name: DEMO_ALWAYS_ON.name,
      platform: 'macos',
      version: '0.6.2',
      pairedAt: now - 21 * 24 * HOUR,
      lastSeen: now - 4_000,
      status: 'online',
      skew: 'same',
      rttMs: Math.round(wave(now, 14, 26, 90_000)),
      alwaysOn: true,
      kind: 'mac-mini',
      info: {
        at: now - 4_000,
        version: '0.6.2',
        ipc: 1,
        kind: 'mac-mini',
        cpus: 10,
        loadPerCore: wave(now, 0.08, 0.22, 120_000),
        memory: { freeGB: wave(now, 18.5, 21, 300_000, 1), totalGB: 32 },
        disk: { freeGB: 412.6, totalGB: 1000 },
        agentsRunning: 0,
        runtimes: [
          { id: 'claude', state: 'ready', usage: usage(now, 18, 41) },
          { id: 'codex', state: 'ready' },
        ],
        gh: 'signed_in',
        mcp: [
          { name: 'github', from: 'user' },
          { name: 'linear', from: 'user' },
        ],
        projects: [
          { name: 'landing', origin: origin('landing') },
          { name: 'bob-api', origin: origin('bob-api') },
        ],
        work: [],
      },
    },
    {
      id: 'de30a1c0ffee0002',
      name: 'build-box',
      platform: 'linux',
      version: '0.6.2',
      pairedAt: now - 6 * 24 * HOUR,
      lastSeen: now - 9_000,
      status: 'online',
      skew: 'same',
      rttMs: Math.round(wave(now, 58, 84, 75_000, 2)),
      kind: 'aws',
      region: 'eu-west-1',
      ssh: 'ubuntu@aws-server',
      info: {
        at: now - 9_000,
        version: '0.6.2',
        ipc: 1,
        kind: 'aws',
        region: 'eu-west-1',
        cpus: 16,
        loadPerCore: wave(now, 0.46, 0.71, 60_000, 0.5),
        memory: { freeGB: wave(now, 22, 27.5, 200_000), totalGB: 64 },
        disk: { freeGB: 168.2, totalGB: 250 },
        agentsRunning: work.length || 1,
        runtimes: [
          { id: 'claude', state: 'ready', usage: usage(now, 63, 72) },
          { id: 'codex', state: 'signed_out' },
        ],
        gh: 'signed_in',
        mcp: [{ name: 'github', from: 'user' }],
        projects: [{ name: 'bob-api', origin: origin('bob-api') }],
        work,
      },
    },
  ];
}
