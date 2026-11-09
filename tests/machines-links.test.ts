import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/core/store.js';
import { encodeFrame, parseDaemonFrame } from '../src/ipc/protocol.js';
import { StateCache } from '../src/machines/cache.js';
import { MachineDoor } from '../src/machines/door.js';
import { demoLinkMs, withLatency } from '../src/machines/latency.js';
import { LOST_LINK_MS, linkHealth } from '../src/machines/links.js';
import type { Machines } from '../src/machines/machines.js';
import { DEFLATE_FROM, fromStream } from '../src/net/transport.js';
import { linkSampleOf, watchLink } from '../packages/mac/src/machines/link-health.js';
import { waitFor } from './helpers.js';

/**
 * Remote work feels local (BLG-792): a computer's last state kept on this Mac draws its screen at
 * once (after a restart too, and offline) and the computer's own catches up; big frames go
 * compressed only to a side that inflates; a slow or lost link is said; the demo's link can be slowed.
 */

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-links-'));
  dirs.push(d);
  return d;
};

const state = (room: string) => initialState(room);

describe('StateCache', () => {
  it('keeps a computer’s state in step with its actions and reads it back after a restart', async () => {
    const dir = tmp();
    const cache = new StateCache({ dir, saveMs: 10 });
    cache.reset('m1', state('mini'), 4, '0.6.2');
    cache.apply('m1', 5, { type: 'identity', selfId: 'peer-1', isHost: true });
    // Out of order: waits for the next snapshot.
    cache.apply('m1', 9, { type: 'identity', selfId: 'peer-9', isHost: true });
    expect(cache.get('m1')).toMatchObject({ seq: 5, version: '0.6.2', snapshot: { selfId: 'peer-1' } });
    await cache.flush();
    const again = new StateCache({ dir });
    expect(again.get('m1')).toMatchObject({ seq: 5, version: '0.6.2', snapshot: { selfId: 'peer-1', room: 'mini' } });
    expect(again.get('m2')).toBeUndefined();
  });

  it('forgets a computer’s state, here and on disk', async () => {
    const dir = tmp();
    const cache = new StateCache({ dir, saveMs: 10 });
    cache.reset('m1', state('mini'), 1);
    await cache.flush();
    await cache.clear('m1');
    expect(cache.get('m1')).toBeUndefined();
    expect(new StateCache({ dir }).get('m1')).toBeUndefined();
  });
});

/** A computer `rtt` ms away: says welcome to a hello, answers each call, pongs pings. */
class SlowComputer extends EventEmitter {
  isOpen = true;
  constructor(
    private readonly rtt: number,
    private readonly room = 'live',
  ) {
    super();
  }
  send(text: string): void {
    const f = JSON.parse(text) as { t: string; id?: string };
    const later = (reply: object): void => void setTimeout(() => this.isOpen && this.emit('message', encodeFrame(reply as never)), this.rtt);
    if (f.t === 'hello') later({ t: 'welcome', clientId: 'c', version: '0.7.0', ipc: 1, snapshot: state(this.room), seq: 10, clients: 1 });
    else if (f.t === 'call') later({ t: 'result', id: f.id, ok: true, value: 'opened' });
    else if (f.t === 'ping') later({ t: 'pong' });
  }
  close(): void {
    this.isOpen = false;
    this.emit('close', 1006);
  }
  terminate(): void {
    this.close();
  }
  ping(): void {}
}

class Screen extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly got: Array<{ t: string; at: number; id?: string; snapshot?: { room: string } }> = [];
  constructor(private readonly started = performance.now()) {
    super();
  }
  send(text: string): void {
    this.got.push({ ...(parseDaemonFrame(text) as object as { t: string }), at: performance.now() - this.started });
  }
  close(): void {
    this.readyState = 3;
  }
  say(frame: object): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }
}

function door(states: StateCache, link: () => Promise<unknown>): MachineDoor {
  const machines = { book: { get: () => ({ name: 'Mini' }) }, drives: () => true, openLink: link } as unknown as Machines;
  return new MachineDoor(machines, { states, backoffMs: [60_000] });
}
const hello = { t: 'hello' as const, token: 't'.repeat(32), ipc: 1, kind: 'mac' as const, version: '1', caps: [] };

describe('a computer’s screen with 80 ms added round trip', () => {
  it('draws from what was kept at once, then catches up with the computer’s own', async () => {
    const states = new StateCache({ dir: tmp() });
    states.reset('mini', state('kept'), 3, '0.6.9');
    const d = door(states, async () => new SlowComputer(80));
    const screen = new Screen();
    d.open('mini', screen as never, hello);
    expect(screen.got[0]).toMatchObject({ t: 'welcome', snapshot: { room: 'kept' } });
    expect(screen.got[0]!.at).toBeLessThan(20);
    await waitFor(() => screen.got.some((f) => f.t === 'snapshot'), 5_000);
    expect(screen.got.find((f) => f.t === 'snapshot')).toMatchObject({ snapshot: { room: 'live' } });
    // What the computer said is what's kept now.
    expect(states.get('mini')).toMatchObject({ seq: 10, version: '0.7.0', snapshot: { room: 'live' } });
    d.closeAll('done');
  });

  it('opens a worktree there well under 300 ms', async () => {
    const d = door(new StateCache(), async () => new SlowComputer(80));
    const screen = new Screen();
    d.open('mini', screen as never, hello);
    await waitFor(() => screen.got.some((f) => f.t === 'welcome'), 5_000);
    const asked = performance.now();
    screen.say({ t: 'call', id: '1', method: 'workspaces.open', args: ['ws-1'] });
    await waitFor(() => screen.got.some((f) => f.t === 'result'), 5_000);
    expect(performance.now() - asked).toBeLessThan(300);
    d.closeAll('done');
  });

  it('stays readable while the computer can’t be reached, its calls said at once', async () => {
    const states = new StateCache();
    states.reset('mini', state('kept'), 3);
    const d = door(states, () => new Promise(() => undefined));
    const screen = new Screen();
    d.open('mini', screen as never, hello);
    expect(screen.got[0]).toMatchObject({ t: 'welcome', snapshot: { room: 'kept' } });
    screen.say({ t: 'call', id: '1', method: 'workspaces.open', args: ['ws-1'] });
    expect(screen.got[1]).toMatchObject({ t: 'result', id: '1', ok: false });
    d.closeAll('done');
  });
});

describe('compressed frames on a computer’s link', () => {
  function pair(a: { compress?: boolean }, b: { compress?: boolean }) {
    const ab = new PassThrough();
    const ba = new PassThrough();
    let wire = 0;
    ab.on('data', (c: Buffer) => (wire += c.length));
    const left = fromStream(Duplex.from({ writable: ab, readable: ba } as never), { maxBytes: 4 * 1024 * 1024, open: true, ...a });
    const right = fromStream(Duplex.from({ writable: ba, readable: ab } as never), { maxBytes: 4 * 1024 * 1024, open: true, ...b });
    return { left, right, wire: () => wire };
  }
  const big = JSON.stringify({ t: 'snapshot', log: Array.from({ length: 2000 }, (_, i) => ({ id: i, text: 'Claude edited src/app.ts and ran the tests' })) });

  it('goes compressed when both sides inflate, and arrives whole', async () => {
    const { left, right, wire } = pair({ compress: true }, { compress: true });
    const got: string[] = [];
    right.on('message', (t) => got.push(t));
    await new Promise((r) => setImmediate(r));
    left.send(big);
    left.send('small');
    await waitFor(() => got.length === 2, 2_000);
    expect(got).toEqual([big, 'small']);
    expect(wire()).toBeLessThan(big.length / 5);
  });

  it('stays plain to a side that doesn’t inflate (an older Beluga)', async () => {
    const { left, right, wire } = pair({ compress: true }, {});
    const got: string[] = [];
    right.on('message', (t) => got.push(t));
    await new Promise((r) => setImmediate(r));
    left.send(big);
    await waitFor(() => got.length === 1, 2_000);
    expect(got[0]).toBe(big);
    expect(wire()).toBeGreaterThan(big.length);
    expect(big.length).toBeGreaterThan(DEFLATE_FROM);
  });
});

describe('link health', () => {
  it('says slow past 300 ms, lost when a ping goes unanswered or no screen is open', () => {
    expect(linkHealth({ connected: true, rttMs: 80 }).state).toBe('ok');
    expect(linkHealth({ connected: true, rttMs: 420 }, 'Mac mini')).toMatchObject({ state: 'slow', rttMs: 420, words: expect.stringContaining('Mac mini') });
    expect(linkHealth({ connected: true, rttMs: 40, waitingMs: 900 }).state).toBe('slow');
    expect(linkHealth({ connected: true, rttMs: 40, waitingMs: LOST_LINK_MS }).state).toBe('lost');
    expect(linkHealth({ connected: false }).state).toBe('lost');
  });

  it('a screen’s pings: answered is a round trip, unanswered goes lost, closed is not connected', async () => {
    vi.useFakeTimers();
    let answer: ((ms: number) => void) | undefined;
    const beat = (tick: () => void, ms: number): (() => void) => {
      const t = setInterval(tick, ms);
      return () => clearInterval(t);
    };
    const stop = watchLink('mini', { ping: () => new Promise<number>((r) => (answer = r)) }, beat, 1_000);
    answer!(85);
    await vi.advanceTimersByTimeAsync(0);
    expect(linkSampleOf('mini')).toEqual({ connected: true, rttMs: 85 });
    // The next ping never comes back.
    await vi.advanceTimersByTimeAsync(1_000 + LOST_LINK_MS);
    expect(linkHealth(linkSampleOf('mini')!).state).toBe('lost');
    stop();
    expect(linkSampleOf('mini')).toEqual({ connected: false });
    expect(linkSampleOf('never-opened')).toBeUndefined();
  });
});

describe('the demo’s slow link', () => {
  it('delays every frame both ways, in order', async () => {
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, sent: [] as Array<{ data: unknown; at: number }>, send(data: unknown) {} });
    const t0 = performance.now();
    ws.send = (data: unknown) => void ws.sent.push({ data, at: performance.now() - t0 });
    withLatency(ws as never, 40);
    const got: Array<{ v: unknown; at: number }> = [];
    ws.on('message', (v) => got.push({ v, at: performance.now() - t0 }));
    ws.emit('message', 'a');
    ws.emit('message', 'b');
    (ws as unknown as { send(d: string): void }).send('out');
    await waitFor(() => got.length === 2 && ws.sent.length === 1, 2_000);
    expect(got.map((g) => g.v)).toEqual(['a', 'b']);
    expect(got[0]!.at).toBeGreaterThanOrEqual(35);
    expect(ws.sent[0]!.at).toBeGreaterThanOrEqual(35);
    expect(demoLinkMs({ BELUGA_DEMO_LINK_MS: '80' })).toBe(80);
    expect(demoLinkMs({})).toBe(0);
  });
});
