import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunFolders, pruneRuns } from '../src/core/sentinel/files.js';
import { brief, setup, until } from './sentinel-fakes.js';

/** ~/.beluga/sentinel.json and the runs' folders (docs/sentinel.md §2, §4 "File"). */

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-sentinel-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('sentinel.json', () => {
  it('keeps sentinels and their runs, with each run’s folder, across restarts', async () => {
    const dir = tmp();
    const a = setup({ dir, reply: () => '# All quiet\n\nNothing moved.' });
    const made = a.sentinels.create(brief);
    a.sentinels.pause(made.id, false);
    const run = a.sentinels.start(made.id, 'you');
    await until(() => a.sentinels.runGet(run.id).run.state === 'done');
    a.sentinels.stopAll();
    const file = path.join(dir, 'sentinel.json');
    // Windows has no Unix modes: the user profile's own ACL keeps it private there.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: number; runAtOnce: number; items: unknown[]; runs: Array<{ steps: Array<{ output?: string }> }> };
    expect(saved).toMatchObject({ version: 1, runAtOnce: 2 });
    expect(saved.items).toHaveLength(1);
    // The index has no outputs; they're in the run's folder.
    expect(saved.runs[0]!.steps.every((s) => s.output === undefined)).toBe(true);
    const folder = path.join(dir, 'sentinel', 'runs', run.id);
    expect(readdirSync(folder).sort()).toEqual(['report.md', 'step-1.txt', 'step-2.txt', 'trigger.json']);
    expect(readFileSync(path.join(folder, 'report.md'), 'utf8')).toBe('# All quiet\n\nNothing moved.');

    const b = setup({ dir });
    expect(b.sentinels.list().map((s) => [s.name, s.paused])).toEqual([['Morning brief', false]]);
    const again = b.sentinels.runGet(run.id);
    expect(again.run).toMatchObject({ state: 'done', headline: 'All quiet', report: path.join(folder, 'report.md') });
    expect(again.run.steps[0]!.output).toBe('# All quiet\n\nNothing moved.');
    expect(again.report).toBe('# All quiet\n\nNothing moved.');
    expect(b.store.getState().sentinel.runs).toHaveLength(1);
  });

  it('secrets in an output are redacted before they’re kept', async () => {
    const dir = tmp();
    const s = setup({ dir, shell: async () => ({ exitCode: 0, output: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n', truncated: false, timedOut: false, ms: 1 }) });
    const run = s.sentinels.start(s.sentinels.create({ name: 'Env', steps: [{ kind: 'script', command: 'env', cwd: 'home', timeoutSec: 5 }] }).id, 'you');
    await until(() => s.sentinels.runGet(run.id).run.state === 'done');
    expect(readFileSync(path.join(dir, 'sentinel', 'runs', run.id, 'step-1.txt'), 'utf8')).toBe('GITHUB_TOKEN=[redacted]\n');
    expect(s.sentinels.runGet(run.id).run.steps[0]!.output).not.toContain('ghp_');
  });

  it('a run Beluga closed during ended there', () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, 'sentinel.json'),
      JSON.stringify({
        version: 1,
        items: [{ id: 'sn_1', name: 'Brief', trigger: { kind: 'manual' }, steps: [], createdAt: 1, updatedAt: 1 }],
        runs: [{ id: 'run_1', sentinelId: 'sn_1', by: 'you', trigger: { kind: 'manual', summary: 'x' }, state: 'running', startedAt: 5, headline: '', steps: [{ id: 'st', state: 'running' }], tasks: [] }],
      }),
    );
    const s = setup({ dir });
    expect(s.sentinels.runsOf('sn_1')[0]).toMatchObject({ state: 'failed', why: 'Beluga closed while it ran', steps: [{ id: 'st', state: 'skipped' }] });
    // Filled in from what was saved.
    expect(s.sentinels.need('sn_1')).toMatchObject({ icon: 'eye', access: 'look', notify: 'mac', paused: true, limits: { minutes: 30, pauseAfter: 3 } });
  });

  it('sentinels that don’t read are kept beside it; an unreadable file is set aside', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'sentinel.json'), JSON.stringify({ version: 1, items: [{ id: 'sn_ok', name: 'Fine', trigger: { kind: 'manual' }, createdAt: 1, updatedAt: 1 }, { id: 'sn_bad', name: 'Broken', trigger: { kind: 'schedule', every: 'fortnight' } }] }));
    const s = setup({ dir });
    expect(s.sentinels.list().map((i) => i.id)).toEqual(['sn_ok']);
    const dropped = readdirSync(dir).find((f) => f.startsWith('sentinel.dropped-'))!;
    expect(JSON.parse(readFileSync(path.join(dir, dropped), 'utf8'))).toEqual({ items: [{ id: 'sn_bad', name: 'Broken', trigger: { kind: 'schedule', every: 'fortnight' } }], runs: [] });

    const other = tmp();
    writeFileSync(path.join(other, 'sentinel.json'), '{"version": 9}');
    const t = setup({ dir: other });
    expect(t.sentinels.list()).toEqual([]);
    expect(readdirSync(other).some((f) => f.startsWith('sentinel.json.unreadable-'))).toBe(true);
  });

  it('a sentinel saved with a Stripe trigger waits for Run, and a Stripe-signed webhook takes any post', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'sentinel.json'), JSON.stringify({ version: 1, items: [{ id: 'sn_pay', name: 'Failed payments', trigger: { kind: 'stripe', what: 'payment-failed' }, createdAt: 1, updatedAt: 1 }, { id: 'sn_hook', name: 'Hook', trigger: { kind: 'webhook', signature: 'stripe' }, createdAt: 1, updatedAt: 1 }] }));
    const s = setup({ dir });
    expect(s.sentinels.list().map((i) => [i.id, i.trigger])).toEqual([['sn_pay', { kind: 'manual' }], ['sn_hook', { kind: 'webhook' }]]);
    expect(readdirSync(dir).some((f) => f.startsWith('sentinel.dropped-'))).toBe(false);
  });

  it('folders no run has any more go (a deleted sentinel’s, with the next start)', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'sentinel', 'runs', 'run_orphan'), { recursive: true });
    writeFileSync(path.join(dir, 'sentinel', 'runs', 'run_orphan', 'report.md'), 'old');
    setup({ dir });
    expect(existsSync(path.join(dir, 'sentinel', 'runs', 'run_orphan'))).toBe(false);
  });
});

describe('pruning', () => {
  it('keeps the last 200 runs of each sentinel, and never one still going', () => {
    const runs = [
      { id: 'live', sentinelId: 'a', state: 'running' },
      ...Array.from({ length: 205 }, (_, i) => ({ id: `a${i}`, sentinelId: 'a', state: 'done' })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, sentinelId: 'b', state: 'done' })),
    ];
    const { kept, gone } = pruneRuns(runs);
    expect(kept.filter((r) => r.sentinelId === 'a')).toHaveLength(201);
    expect(kept[0]!.id).toBe('live');
    expect(gone).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    expect(kept.filter((r) => r.sentinelId === 'b')).toHaveLength(3);
  });

  it('a run folder in memory without a home', () => {
    const folders = new RunFolders(null);
    folders.write('r1', 'report.md', 'hi');
    expect(folders.read('r1', 'report.md')).toBe('hi');
    expect(folders.pathOf('r1', 'report.md')).toBeUndefined();
    folders.remove('r1');
    expect(folders.read('r1', 'report.md')).toBeUndefined();
  });
});
