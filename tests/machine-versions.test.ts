import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DeviceBook } from '../src/companion/devices.js';
import { CompanionHost } from '../src/companion/host.js';
import { Store, initialState } from '../src/core/store.js';
import { IPC_VERSION } from '../src/ipc/protocol.js';
import type { MachineInfo } from '../src/machines/info.js';
import { Machines } from '../src/machines/machines.js';
import { ComputerUpdater, busyTerminals, leftBehind, parsePs, runningHere, skewOf, skewWords } from '../src/machines/versions.js';
import { generateIdentity } from '../src/net/crypto.js';
import type { MachineIcon } from '../src/shared/settings-schema.js';
import { waitFor } from './helpers.js';

/** Versions and updates across your computers (BLG-777). */

const working = { log: [{ type: 'agent', status: 'tool' }, { type: 'agent', status: 'done' }] } as never;
const quiet = { log: [] } as never;

describe('versions in plain words', () => {
  it('tells an older computer from a newer one, and says which side to update', () => {
    expect(skewOf(2, 2)).toBe('same');
    expect(skewOf(2, undefined)).toBe('same');
    expect(skewOf(2, 1)).toBe('older');
    expect(skewOf(2, 3)).toBe('newer');
    expect(skewWords('mini', '0.6.0', 'older')).toEqual({ text: 'mini runs an older Beluga (0.6.0): Update It to work there again.', update: 'computer' });
    expect(skewWords('mini', '0.9.0', 'newer')?.update).toBe('app');
    expect(skewWords('mini', '0.9.0', 'same')).toBeUndefined();
  });

  it('an app update leaves behind only the computers on an older protocol', () => {
    const computers = [
      { name: 'mini', ipc: 1 },
      { name: 'aws', ipc: 2 },
      { name: 'pi' },
    ];
    expect(leftBehind(2, computers).map((c) => c.name)).toEqual(['mini']);
    expect(leftBehind(undefined, computers)).toEqual([]);
  });

  it('counts terminals running a program, not shells at their prompt, as the Mac does', () => {
    const procs = parsePs(['  100     1   100   100', '  200     1   200   250', '  250   200   250   250', '  300     1   300    -1', 'junk'].join('\n'));
    expect(procs).toHaveLength(4);
    expect(busyTerminals(procs, [100, 200, 300])).toBe(1);
    expect(runningHere(working, 1)).toEqual(['1 agent working', '1 terminal running a program']);
    expect(runningHere(quiet, 0)).toEqual([]);
  });
});

describe('Update It on a computer', () => {
  /** `ps` null: it can't be told what runs in the terminals. */
  function updater(state: () => never, shells: number[] = [], ps: string | null = '') {
    const runs: number[] = [];
    const u = new ComputerUpdater({ state, shells: () => shells, ps: async () => (ps === null ? undefined : parsePs(ps)), run: () => void runs.push(Date.now()), name: () => 'mini', everyMs: 20 });
    return { u, runs };
  }

  it('updates at once when nothing runs', async () => {
    const { u, runs } = updater(() => quiet);
    expect((await u.request('ask')).state).toBe('updating');
    expect(runs).toHaveLength(1);
  });

  it('asks first, saying what runs there, and doesn’t update', async () => {
    const { u, runs } = updater(() => working, [200], '  200 1 200 250\n');
    const answer = await u.request('ask');
    expect(answer).toMatchObject({ state: 'busy', running: ['1 agent working', '1 terminal running a program'] });
    expect(answer.message).toMatch(/mini has 1 agent working and 1 terminal running a program/);
    expect(runs).toEqual([]);
  });

  it('when idle: waits for the runs to finish, then updates', async () => {
    let state: never = working;
    const { u, runs } = updater(() => state);
    expect((await u.request('when-idle')).state).toBe('waiting');
    await new Promise((r) => setTimeout(r, 80));
    expect(runs).toEqual([]);
    state = quiet;
    await waitFor(() => runs.length === 1, 3_000);
    u.stop();
  });

  it('now: stops what runs; a terminal it can’t look into counts as busy', async () => {
    const { u, runs } = updater(() => quiet, [100], null);
    expect((await u.request('ask')).running).toEqual(['1 terminal running a program']);
    expect((await u.request('now')).state).toBe('updating');
    expect(runs).toHaveLength(1);
  });

  it('a Beluga that can’t update itself says so', async () => {
    const u = new ComputerUpdater({ state: () => quiet, shells: () => [], ps: async () => [], name: () => 'mini' });
    expect(await u.request('now')).toMatchObject({ state: 'unsupported' });
  });
});

let testnet: Testnet;
const cleanup: Array<() => Promise<void> | void> = [];
beforeAll(async () => {
  testnet = await createTestnet(3);
}, 30_000);
afterAll(async () => {
  await testnet.destroy();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function install(name: string, extra: { ipc?: number; updater?: ComputerUpdater } = {}) {
  // Its name and icon as its own settings keep them (BLG-780).
  const kept: { name: string; icon?: MachineIcon } = { name };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-versions-'));
  const identity = generateIdentity();
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: identity.peerId, isHost: true });
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
  let host!: CompanionHost;
  const info = async (): Promise<MachineInfo> => ({ at: Date.now(), name: kept.name, ...(kept.icon ? { icon: kept.icon } : {}), version: '0.6.0', ipc: extra.ipc ?? IPC_VERSION, cpus: 4, loadPerCore: 0.1, memory: { freeGB: 4, totalGB: 8 }, agentsRunning: 0, runtimes: [], gh: 'missing', mcp: [], projects: [] });
  const machines = new Machines({
    dir,
    identity,
    devices,
    node: () => host.dhtNode(),
    address: () => host.address(),
    relayUrl: () => host.relayUrl(),
    relay: { add: (r) => host.reach.server.add(r), remove: (k) => host.reach.server.remove(k) },
    name: () => kept.name,
    version: '0.6.0',
    setLook: (look) => Object.assign(kept, look),
    platform: 'linux',
    removePhone: (id) => void host.removeDevice(id),
    onChange: () => host.machinesChanged(),
    pollMs: 60_000,
    info,
    ...(extra.updater ? { updater: extra.updater } : {}),
  });
  host = new CompanionHost({ identity, store, devices, call: async () => ({ ok: true, value: undefined }), macName: () => name, version: '0.6.0', thumbsDir: path.join(dir, 'thumbs'), uploadsDir: path.join(dir, 'uploads'), dht: { bootstrap: testnet.bootstrap, host: '127.0.0.1' }, coalesceMs: 50, machines });
  cleanup.push(async () => {
    await machines.stop();
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.start();
  machines.start();
  return { machines, kept };
}

describe('across the link', () => {
  it('a computer on an older protocol is listed read-only, with Update It; it asks, then updates', async () => {
    let state: never = working;
    const runs: number[] = [];
    const updater = new ComputerUpdater({ state: () => state, shells: () => [], ps: async () => [], run: () => void runs.push(1), name: () => 'mini' });
    const app = await install('MacBook');
    const mini = await install('mini', { ipc: Math.max(0, IPC_VERSION - 1), updater });
    const info = await mini.machines.pairStart();
    await app.machines.joinStart(info.link);
    const { id } = await app.machines.joinApprove();
    await app.machines.poll();
    const [view] = app.machines.list();
    if (IPC_VERSION > 0) expect(view).toMatchObject({ skew: 'older', readOnly: true, update: 'computer', note: 'mini runs an older Beluga (0.6.0): Update It to work there again.' });
    // The app's next version (one protocol on) would leave it behind.
    expect(app.machines.leftBehind(IPC_VERSION + 1).map((m) => m.name)).toEqual(['mini']);

    // Update It: something runs there, so it asks.
    const asked = await app.machines.update(id, 'ask');
    expect(asked).toMatchObject({ state: 'busy', running: ['1 agent working'] });
    expect(runs).toEqual([]);
    state = quiet;
    expect((await app.machines.update(id, 'ask')).state).toBe('updating');
    expect(runs).toHaveLength(1);
  }, 120_000);
});

describe('renaming a computer and its icon (BLG-780)', () => {
  it('are kept on the computer itself, and read back the same', async () => {
    const app = await install('MacBook');
    const mini = await install('mini');
    const info = await mini.machines.pairStart();
    await app.machines.joinStart(info.link);
    const { id } = await app.machines.joinApprove();
    const view = await app.machines.look(id, { name: 'Mac mini at home', icon: 'desktop' });
    expect(view).toMatchObject({ name: 'Mac mini at home', icon: 'desktop' });
    // Kept there: the computer's own name changed, so any device that asks hears it.
    expect(mini.kept).toEqual({ name: 'Mac mini at home', icon: 'desktop' });
    expect(mini.machines.hereName()).toBe('Mac mini at home');
    // And here, offline or not, the book has it too.
    expect(app.machines.book.get(id)).toMatchObject({ name: 'Mac mini at home', icon: 'desktop' });
    await app.machines.poll();
    expect(app.machines.list()[0]).toMatchObject({ name: 'Mac mini at home', icon: 'desktop' });
  }, 120_000);
});

