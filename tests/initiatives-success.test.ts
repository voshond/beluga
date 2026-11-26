import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineVerdict, parseProposal } from '../src/agent/success-definer.js';
import { demoPeek, demoSuccessProposal } from '../src/core/initiatives/demo-success.js';
import { type CheckInHost, Initiatives } from '../src/core/initiatives/initiatives.js';
import { CHECK_IN_CHAT, initiativeChatChannel } from '../src/core/initiatives/model.js';
import { beforeSince, keptQuery, looksSecret, scopeChange, SuccessSourceSchema, valueOf, verdictOf } from '../src/core/initiatives/success.js';
import type { SuccessHost } from '../src/core/initiatives/success-service.js';
import type { ScheduleTrigger, SentinelDraft, StepDraft } from '../src/core/sentinel/model.js';
import type { TileInput } from '../src/core/sentinel/dashboards.js';
import { Store, initialState } from '../src/core/store.js';

const SELF = 'peer-12345678';
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-success-'));
const DAY = 86_400_000;

describe('success model', () => {
  const metric = demoSuccessProposal('Checkout v2').metrics[0]!;

  it('keeps the baseline and target beside the value', () => {
    expect(keptQuery({ ...metric, source: { ...metric.source, query: 'SELECT 1 AS value;' } }, 61.5)).toBe('SELECT v.value AS value, 61.5 AS baseline, 64 AS target FROM (SELECT 1 AS value) AS v');
  });

  it('reads the value column, or the only number', () => {
    expect(valueOf([{ value: '12.5' }])).toBe(12.5);
    expect(valueOf([{ day: 'mon', n: 3 }])).toBe(3);
    expect(valueOf([{ a: 1, b: 2 }])).toBeUndefined();
    expect(valueOf([])).toBeUndefined();
  });

  it('keeps no address, variable or key in a source', () => {
    expect(SuccessSourceSchema.parse({ kind: 'postgres', query: 'SELECT 1', url: 'postgres://u:p@h/db', env: 'DATABASE_URL' })).toEqual({ kind: 'postgres', query: 'SELECT 1' });
    expect(looksSecret("SELECT * FROM dblink('postgresql://u:p@h/db', 'x')")).toBe(true);
    expect(looksSecret('SELECT count(*) AS value FROM orders')).toBe(false);
  });

  it('notices tickets that came or went', () => {
    expect(scopeChange(['A-1', 'A-2'], ['A-1', 'A-2'])).toBeUndefined();
    expect(scopeChange(['A-1', 'A-2'], ['A-2', 'A-3'])).toEqual({ added: ['A-3'], removed: ['A-1'] });
    expect(scopeChange(undefined, ['A-1'])).toBeUndefined();
    expect(scopeChange([], ['A-1'])).toEqual({ added: ['A-1'], removed: [] });
  });

  it('compares before and since the ship date, the baseline standing in for before', () => {
    const shipped = 10 * DAY;
    const points = [
      { at: 8 * DAY, value: 50 },
      { at: 9 * DAY, value: 52 },
      { at: 11 * DAY, value: 60 },
      { at: 12 * DAY, value: 62 },
    ];
    expect(beforeSince(points, shipped, 40)).toEqual({ latest: 62, before: 51, since: 61, beforeCount: 2, sinceCount: 2 });
    expect(beforeSince(points.slice(2), shipped, 40)).toMatchObject({ before: 40, since: 61, beforeCount: 0 });
    expect(beforeSince(points, undefined, 40)).toEqual({ latest: 62, before: 40, beforeCount: 0, sinceCount: 0 });
  });

  it('judges a number in its direction', () => {
    expect(verdictOf(65, { direction: 'up', target: 64, baseline: 58 })).toBe('met');
    expect(verdictOf(60, { direction: 'up', target: 64, baseline: 58 })).toBe('better');
    expect(verdictOf(58.2, { direction: 'up', target: 64, baseline: 58 })).toBe('flat');
    expect(verdictOf(15, { direction: 'down', target: 12, baseline: 14 })).toBe('worse');
    expect(verdictOf(undefined, { direction: 'down', target: 12, baseline: 14 })).toBe('unknown');
  });
});

describe('the success pass', () => {
  it('reads only the linked repos, never a secret, and tries sources', () => {
    const roots = ['/code/shop'];
    expect(defineVerdict(roots, 'Read', { file_path: '/code/shop/db/schema.sql' }).allow).toBe(true);
    expect(defineVerdict(roots, 'Grep', { path: 'migrations' }).allow).toBe(true);
    expect(defineVerdict(roots, 'Read', { file_path: '/code/shop/.env' }).allow).toBe(false);
    expect(defineVerdict(roots, 'Read', { file_path: '/etc/passwd' }).allow).toBe(false);
    expect(defineVerdict(roots, 'Bash', { command: 'ls' }).allow).toBe(false);
    expect(defineVerdict(roots, 'mcp__beluga_success__try_source', {}).allow).toBe(true);
    expect(defineVerdict(roots, 'mcp__beluga_sentinel__sentinel_create', {}).allow).toBe(false);
  });

  it('takes JSON, at most three metrics, and drops one carrying a secret', () => {
    const base = demoSuccessProposal('X');
    const leaky = { ...base.metrics[0]!, name: 'leaky', source: { kind: 'postgres', query: "SELECT 1 FROM dblink('postgres://u:p@h/db')" } };
    const said = `Here it is:\n${JSON.stringify({ ...base, metrics: [...base.metrics, leaky, { ...base.metrics[0]!, name: 'third' }, { ...base.metrics[0]!, name: 'fourth' }] })}`;
    const parsed = parseProposal(said)!;
    expect(parsed.metrics.map((m) => m.name)).toEqual(['conversion', 'payment_drop', 'third']);
    expect(parseProposal('no json here')).toBeUndefined();
  });
});

type Fake = SuccessHost & { readonly drafts: SentinelDraft[]; readonly updates: Array<readonly StepDraft[]>; readonly paused: Set<string>; readonly boards: Map<string, readonly TileInput[]>; readonly peeked: string[] };

const fakeSuccess = (): Fake => {
  const drafts: SentinelDraft[] = [];
  const updates: Array<readonly StepDraft[]> = [];
  const paused = new Set<string>();
  const boards = new Map<string, readonly TileInput[]>();
  const peeked: string[] = [];
  return {
    drafts,
    updates,
    paused,
    boards,
    peeked,
    peek: async (source) => {
      peeked.push(source.query);
      return demoPeek(source);
    },
    sentinelExists: (id) => Number(id.slice(2)) <= drafts.length,
    createSentinel: (draft) => {
      drafts.push(draft);
      paused.add(`sn${drafts.length}`);
      return { id: `sn${drafts.length}` };
    },
    updateSentinel: (_id, _name, steps) => void updates.push(steps),
    pauseSentinel: (id) => void paused.add(id),
    putDashboard: (id, _name, tiles) => {
      const board = id ?? `db${boards.size + 1}`;
      boards.set(board, tiles);
      return board;
    },
    points: () => [
      { at: Date.parse('2026-11-01'), value: 55 },
      { at: Date.parse('2026-11-20'), value: 63 },
    ],
  };
};

const checkInHost = (): CheckInHost & { readonly triggers: Map<string, ScheduleTrigger> } => {
  const triggers = new Map<string, ScheduleTrigger>();
  return { triggers, create: () => ({ id: 'ci1' }), exists: () => true, pause: () => undefined, runNow: () => undefined, reschedule: (id, t) => void triggers.set(id, t), remove: () => undefined };
};

const setup = async () => {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true, home: '/Users/k' });
  const root = path.join(tmp(), 'initiatives');
  const host = fakeSuccess();
  const checkIns = checkInHost();
  let now = Date.parse('2026-11-10T09:00:00Z');
  const service = new Initiatives({
    store,
    root,
    dir: tmp(),
    selfId: () => SELF,
    ask: () => 'r1',
    checkIns: () => checkIns,
    successHost: () => host,
    defineSuccess: async (req) => demoSuccessProposal(req.name),
    now: () => now,
    claudeDir: tmp(),
  });
  await service.start();
  const { slug } = await service.create({ name: 'Checkout v2', goal: 'Ship it' }, { quiet: true });
  return { store, root, host, checkIns, service, slug, setNow: (at: number) => (now = at) };
};

describe('an initiative’s success', () => {
  it('proposes with each query’s first rows and its baseline, saving nothing', async () => {
    const { service, slug, root } = await setup();
    const draft = await service.defineSuccess(slug);
    expect(draft.proposal.metrics).toHaveLength(2);
    expect(draft.previews.every((p) => p.rows.length === 1 && p.value !== undefined && p.baseline !== undefined)).toBe(true);
    expect(draft.proposal.metrics.every((m) => m.baseline !== undefined)).toBe(true);
    expect(() => readFileSync(path.join(root, slug, 'success.json'), 'utf8')).toThrow();
  });

  it('accepts: success.json, one paused sentinel keeping each metric, one dashboard with numbers and series', async () => {
    const { service, slug, root, host, store } = await setup();
    const { proposal } = await service.defineSuccess(slug);
    const definition = await service.acceptSuccess(slug, { ...proposal, metrics: proposal.metrics.map((m) => ({ ...m, target: 70 })) });
    expect(definition).toMatchObject({ sentinel: 'sn1', dashboard: 'db1' });
    expect(host.paused.has('sn1')).toBe(true);
    const draft = host.drafts[0]!;
    expect(draft.steps).toHaveLength(2);
    expect(draft.steps!.every((st) => st.kind === 'measure' && st.from === 'source' && st.source?.kind === 'bigquery' && /AS baseline, 70 AS target/.test(st.source.query))).toBe(true);
    expect(JSON.stringify(draft)).not.toMatch(/url|env|password/i);
    expect(host.boards.get('db1')!.map((t) => t.kind)).toEqual(['number', 'number', 'number', 'series', 'number', 'number', 'number', 'series']);
    const saved = JSON.parse(readFileSync(path.join(root, slug, 'success.json'), 'utf8'));
    expect(saved.definition.metrics[0].target).toBe(70);
    const item = store.getState().initiatives.items.find((i) => i.slug === slug)!;
    expect(item.success?.definition?.sentinel).toBe('sn1');
    expect(item.timeline[0]).toMatchObject({ kind: 'decision', text: expect.stringContaining('success defined') });
  });

  it('saves nothing when a query fails', async () => {
    const { service, slug, root, host } = await setup();
    const { proposal } = await service.defineSuccess(slug);
    const broken = { ...proposal, metrics: [{ ...proposal.metrics[0]!, source: { ...proposal.metrics[0]!.source, query: 'SELECT FAIL AS value' } }] };
    await expect(service.acceptSuccess(slug, broken)).rejects.toThrow(/did not run, so nothing was saved/);
    expect(host.drafts).toHaveLength(0);
    expect(() => readFileSync(path.join(root, slug, 'success.json'), 'utf8')).toThrow();
  });

  it('refuses a query carrying a connection string', async () => {
    const { service, slug, host } = await setup();
    const { proposal } = await service.defineSuccess(slug);
    const leaky = { ...proposal, metrics: [{ ...proposal.metrics[0]!, baselineQuery: "SELECT 1 AS value FROM dblink('postgres://u:p@h/db')" }] };
    await expect(service.acceptSuccess(slug, leaky)).rejects.toThrow(/connection string or a key/);
    expect(host.peeked).toHaveLength(4);
  });

  it('defining again updates the same sentinel and dashboard', async () => {
    const { service, slug, host } = await setup();
    const { proposal } = await service.defineSuccess(slug);
    await service.acceptSuccess(slug, proposal);
    const again = await service.acceptSuccess(slug, { ...proposal, metrics: proposal.metrics.slice(0, 1) });
    expect(again).toMatchObject({ sentinel: 'sn1', dashboard: 'db1' });
    expect(host.drafts).toHaveLength(1);
    expect(host.updates[0]).toHaveLength(1);
  });

  it('shipped: notes the day, goes weekly, and the check-in reviews the outcome; archived pauses the sentinel only', async () => {
    const { service, slug, host, checkIns, setNow, root } = await setup();
    const { proposal } = await service.defineSuccess(slug);
    await service.acceptSuccess(slug, proposal);
    host.paused.delete('sn1');
    setNow(Date.parse('2026-11-15T09:00:00Z'));
    await service.update(slug, { status: 'shipped' });
    expect(service.success.read(slug).shippedAt).toBe('2026-11-15T09:00:00.000Z');
    expect(checkIns.triggers.get('ci1')).toMatchObject({ every: 'week', days: [1] });
    const run = service.chatRun(initiativeChatChannel(slug, CHECK_IN_CHAT), SELF)!;
    expect(run.brief).toContain('weekly outcome review');
    expect(run.brief).toMatch(/Checkout conversion.*before .*since /);
    expect(service.chatRun(initiativeChatChannel(slug, 'main'), SELF)!.brief).not.toContain('weekly outcome review');
    await service.archive(slug);
    expect(host.paused.has('sn1')).toBe(true);
    expect(host.boards.has('db1')).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, slug, 'success.json'), 'utf8')).shippedAt).toBe('2026-11-15T09:00:00.000Z');
  });

  it('back to active clears the ship date and the weekday check-in returns', async () => {
    const { service, slug, checkIns } = await setup();
    await service.update(slug, { status: 'shipped' });
    await service.update(slug, { status: 'active' });
    expect(service.success.read(slug).shippedAt).toBeUndefined();
    expect(checkIns.triggers.get('ci1')).toMatchObject({ days: [1, 2, 3, 4, 5] });
  });

  it('suggests revisiting the definition when tickets change the scope', async () => {
    const { service, slug, root } = await setup();
    const tickets = (key: string) => JSON.stringify({ at: '2026-11-12T00:00:00Z', epics: [], tickets: [{ key, summary: 'Work', status: 'To Do', statusCategory: 'todo', prs: [] }] });
    writeFileSync(path.join(root, slug, 'tickets.json'), tickets('SHOP-1'));
    const { proposal } = await service.defineSuccess(slug);
    await service.acceptSuccess(slug, proposal);
    expect(service.chatRun(initiativeChatChannel(slug, CHECK_IN_CHAT), SELF)!.brief).not.toContain('Scope changed');
    writeFileSync(path.join(root, slug, 'tickets.json'), tickets('SHOP-9'));
    const brief = service.chatRun(initiativeChatChannel(slug, CHECK_IN_CHAT), SELF)!.brief;
    expect(brief).toContain('Scope changed since success was defined (tickets added: SHOP-9; gone: SHOP-1');
    expect(brief).toContain('Revisit the success definition');
  });
});

describe('success over a real Sentinel', () => {
  it('the demo’s definition makes a paused sentinel and a dashboard of numbers and series', async () => {
    const { setup: sentinelSetup } = await import('./sentinel-fakes.js');
    const { successHostOf } = await import('../src/core/initiatives/launch.js');
    const { sentinels } = sentinelSetup();
    const store = new Store(initialState('room', 'auto'));
    store.dispatch({ type: 'identity', selfId: SELF, isHost: true, home: '/Users/k' });
    const service = new Initiatives({ store, root: path.join(tmp(), 'initiatives'), dir: tmp(), selfId: () => SELF, ask: () => 'r1', successHost: () => successHostOf(sentinels, true), claudeDir: tmp() });
    await service.start();
    const { slug } = await service.create({ name: 'Checkout v2' }, { quiet: true });
    const definition = await service.acceptSuccess(slug, demoSuccessProposal('Checkout v2'));
    const made = sentinels.list().find((x) => x.id === definition.sentinel)!;
    expect(made).toMatchObject({ paused: true, access: 'look' });
    expect(made.steps.map((st) => st.kind)).toEqual(['measure', 'measure']);
    const board = sentinels.dashboards.get(definition.dashboard!)!;
    expect(board.tiles.map((t) => t.kind)).toEqual(['number', 'number', 'number', 'series', 'number', 'number', 'number', 'series']);
  });
});
