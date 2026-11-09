import { describe, expect, it } from 'vitest';
import { tilesOf, variablesOf } from '../src/core/sentinel/move.js';
import { attachSentinel } from '../src/core/sentinel/registry.js';
import type { SourceFetch } from '../src/core/sentinel/runner.js';
import type { Sentinel } from '../src/core/sentinel/model.js';
import { SENTINEL_API } from '../src/ipc/sentinel-api.js';
import { SENTINEL_HANDLERS } from '../src/ipc/sentinel-handlers.js';
import { MoveAsk, type MoveCaller } from '../src/machines/move-plan.js';
import { moveSentinel } from '../src/machines/move-sentinel.js';
import { setup } from './sentinel-fakes.js';

/** BLG-807: a sentinel moves to another computer with its steps, history, kept numbers and tiles. */

const JOBS = [
  { id: 1, file: 'a.pdf' },
  { id: 2, file: 'b.pdf' },
];
const fetchSource: SourceFetch = async () => ({ rows: JOBS, columns: ['id', 'file'] });

/** One computer's sentinels, and its daemon as your app calls it (each call checked against the API). */
function computer(env: Record<string, string>) {
  const s = setup({ fetchSource, envFor: () => env });
  const session = {};
  attachSentinel(session, s.sentinels);
  const caller: MoveCaller & { fail?: string } = {
    async call(method: string, ...args: unknown[]) {
      if (caller.fail === method) throw new Error(`${method} failed`);
      const parsed = SENTINEL_API[method as keyof typeof SENTINEL_API].args.parse(args) as unknown[];
      return (SENTINEL_HANDLERS[method as keyof typeof SENTINEL_HANDLERS] as (x: object, ...a: unknown[]) => unknown)(session, ...parsed);
    },
  };
  return { ...s, caller };
}

/** On this computer: a sentinel keeping jobs from the analytics database, with two runs' numbers and a tile, turned on. */
async function watching(c: ReturnType<typeof computer>): Promise<Sentinel> {
  const made = c.sentinels.create({
    name: 'Jobs',
    projectId: 'api',
    trigger: { kind: 'schedule', every: 'day', at: '08:00', missed: 'skip' },
    steps: [{ kind: 'measure', name: 'Yesterday’s jobs', from: 'source', source: { kind: 'postgres', env: 'ANALYTICS_URL', query: 'select id, file from jobs' }, metrics: [{ name: 'jobs', kind: 'rows', label: 'Jobs' }] }],
  } as never);
  await c.sentinels.test(made.id, 'you');
  await c.sentinels.test(made.id, 'you');
  const board = c.sentinels.dashboards.create('Growth');
  c.sentinels.dashboards.addTile(board.id, { kind: 'table', metric: { sentinelId: made.id, metric: 'jobs' } });
  c.sentinels.dashboards.addTile(board.id, { kind: 'text', title: 'Not its own', sentinelId: 'sn_other' });
  return c.sentinels.pause(made.id, false);
}

const lines = (c: ReturnType<typeof computer>, id: string): number => {
  try {
    return c.sentinels.metricRead(id, 'jobs').lines.length;
  } catch {
    return 0;
  }
};

const move = (a: ReturnType<typeof computer>, b: ReturnType<typeof computer>, id: string, extra: Partial<Parameters<typeof moveSentinel>[0]> = {}) =>
  moveSentinel({ from: a.caller, to: b.caller, sentinelId: id, fromPlace: { name: 'This Mac' }, toPlace: { id: '0123456789abcdef', name: 'build-box' }, projectThere: async () => 'api', sleep: async () => undefined, ...extra });

describe('Move To another computer: a sentinel (BLG-807)', () => {
  it('keeps its history and kept numbers, its tiles follow it, its sources are checked there, and it’s on there as it was', async () => {
    const a = computer({ ANALYTICS_URL: 'postgres://here' });
    const b = computer({ ANALYTICS_URL: 'postgres://there' });
    const s = await watching(a);
    const runs = a.sentinels.runsOf(s.id).length;
    const kept = lines(a, s.id);
    expect(kept).toBe(2);

    const moved = await move(a, b, s.id);
    expect(moved.on).toBe(true);
    expect(moved.notes).toEqual([]);
    // Its tile on Growth, and the one the first number made on Everything.
    expect(moved.landing).toMatchObject({ id: s.id, missing: [], sourcesOk: true, tiles: 2, runs });

    const there = b.sentinels.need(s.id);
    expect(there).toMatchObject({ name: 'Jobs', paused: false, projectId: 'api', trigger: s.trigger, steps: s.steps });
    // Its history, and one more: the check of its sources there.
    expect(b.sentinels.runsOf(s.id)).toHaveLength(runs + 1);
    expect(lines(b, s.id)).toBe(kept + 1);
    // The tile that showed only it is on the board of the same name there, and gone from here; the other stays.
    const growth = b.sentinels.dashboards.get('Growth')!;
    expect(growth.tiles.map((t) => t.metric)).toEqual([{ sentinelId: s.id, metric: 'jobs' }]);
    expect(a.sentinels.dashboards.get('Growth')!.tiles.map((t) => t.sentinelId)).toEqual(['sn_other']);
    // Gone from here.
    expect(a.sentinels.get(s.id)).toBeUndefined();
  });

  it('asks for variables it uses that aren’t there, and waits paused there', async () => {
    const a = computer({ ANALYTICS_URL: 'postgres://here' });
    const b = computer({});
    const s = await watching(a);
    const moved = await move(a, b, s.id);
    expect(moved.landing.missing).toEqual(['ANALYTICS_URL']);
    expect(moved.on).toBe(false);
    expect(moved.notes[0]).toMatch(/needs ANALYTICS_URL on build-box/);
    expect(b.sentinels.need(s.id)).toMatchObject({ paused: true, pausedWhy: expect.stringMatching(/needs ANALYTICS_URL here/) });
  });

  it('a paused one stays paused there; one that runs is asked about first (Pause and Move)', async () => {
    const a = computer({ ANALYTICS_URL: 'x' });
    const b = computer({ ANALYTICS_URL: 'y' });
    const s = await watching(a);
    a.sentinels.pause(s.id, true);
    expect((await move(a, b, s.id)).on).toBe(false);
    expect(b.sentinels.need(s.id).paused).toBe(true);

    const running: MoveCaller = { call: async (m: string) => (m === 'sentinel.moveCheck' ? { running: true, paused: false } : null) };
    const asked = await moveSentinel({ from: running, to: b.caller, sentinelId: 'x', fromPlace: { name: 'This Mac' }, toPlace: { name: 'build-box' }, projectThere: async () => 'api' }).catch((e: unknown) => e);
    expect(asked).toBeInstanceOf(MoveAsk);
  });

  it('a move that fails on the way leaves it where it was, on; a copy whose original can’t go is taken back off', async () => {
    const a = computer({ ANALYTICS_URL: 'x' });
    const b = computer({ ANALYTICS_URL: 'y' });
    const s = await watching(a);
    await expect(move(a, b, s.id, { projectThere: async () => 'missing' })).rejects.toThrow(/project isn’t here/);
    expect(a.sentinels.need(s.id).paused).toBe(false);
    expect(b.sentinels.list()).toEqual([]);
    expect(lines(b, s.id)).toBe(0);

    a.caller.fail = 'sentinel.moveDrop';
    await expect(move(a, b, s.id)).rejects.toThrow(/moveDrop failed/);
    expect(b.sentinels.list()).toEqual([]);
    expect(b.sentinels.dashboards.get('Growth')?.tiles ?? []).toEqual([]);
    expect(a.sentinels.need(s.id).paused).toBe(false);
    expect(a.sentinels.dashboards.get('Growth')!.tiles).toHaveLength(2);
  });
});

describe('what goes with it (BLG-807)', () => {
  it('the variables its steps name, and the tiles that show only it', () => {
    const s = { steps: [{ kind: 'script', command: 'curl -H "Authorization: $API_TOKEN" ${BASE_URL}/x; echo $HOME' }, { kind: 'measure', source: { kind: 'postgres', env: 'ANALYTICS_URL' } }] } as unknown as Sentinel;
    expect(variablesOf(s)).toEqual(['ANALYTICS_URL', 'API_TOKEN', 'BASE_URL']);
    const board = { id: 'd', name: 'Main', compare: 'previous', createdAt: 0, updatedAt: 0, tiles: [
      { id: 't1', kind: 'number', width: 1, metric: { sentinelId: 'sn_a', metric: 'n' } },
      { id: 't2', kind: 'series', width: 3, metrics: [{ sentinelId: 'sn_a', metric: 'n' }, { sentinelId: 'sn_b', metric: 'm' }] },
      { id: 't3', kind: 'divider', width: 6, title: 'x' },
    ] } as never;
    expect(tilesOf([board], 'sn_a')).toEqual([{ dashboard: 'Main', compare: 'previous', tiles: [expect.objectContaining({ id: 't1' })] }]);
  });
});
