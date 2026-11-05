import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepRecord } from '../src/shared/steps.js';

// Counts the run files written each way (the real writes still happen).
const writes = vi.hoisted(() => ({ sync: 0, async: 0 }));
vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>();
  return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => (writes.sync++, fs.writeFileSync(...args)) };
});
vi.mock('node:fs/promises', async (load) => {
  const fs = await load<typeof import('node:fs/promises')>();
  return { ...fs, writeFile: (...args: Parameters<typeof fs.writeFile>) => (writes.async++, fs.writeFile(...args)) };
});

const { StepBook } = await import('../src/core/step-book.js');

const rec = (id: string, extra: Partial<StepRecord> = {}): StepRecord => ({ id, kind: 'tool', tool: 'Bash', title: `Bash ${id}`, status: 'done', startedAt: 1, input: { command: id }, output: `out ${id}`, ...extra });
const saved = (dir: string): { version: number; steps: StepRecord[] } => JSON.parse(readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))!), 'utf8'));
/** Waits on the disk, not on timers (they're faked in some tests); by the clock, as a slow disk (Windows) takes more turns. */
const tick = () => new Promise((r) => setImmediate(r));
const until = async (ok: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await tick();
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-stepsave-'));
  writes.sync = 0;
  writes.async = 0;
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('saving a run’s steps (BLG-407)', () => {
  it('writes while a run goes on without blocking, once per change, and a run’s end is written in full at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const book = new StepBook(dir);
    book.put('k', rec('a', { status: 'running', output: undefined }));
    book.put('k', rec('a'));
    vi.advanceTimersByTime(2_000);
    expect(writes).toEqual({ sync: 0, async: 1 });
    await until(() => readdirSync(dir).some((f) => f.endsWith('.json')));
    expect(saved(dir).steps.map((s) => s.output)).toEqual(['out a']);

    // Nothing new since: the run's end doesn't write it again.
    await until(() => !readdirSync(dir).some((f) => f.endsWith('.tmp')));
    book.flush('k');
    expect(writes).toEqual({ sync: 0, async: 1 });

    // A change, its write in flight, then the run ends: the end is written there and then, and stays.
    book.put('k', rec('b'));
    vi.advanceTimersByTime(2_000);
    book.put('k', rec('c'));
    book.flush('k');
    expect(saved(dir).steps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    for (let i = 0; i < 200; i++) await tick();
    expect(saved(dir).steps.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    // The write in flight is let go: its file goes (a moment later on Windows, whose scanner can hold it).
    await until(() => !readdirSync(dir).some((f) => f.endsWith('.tmp')));
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(new StepBook(dir).page('k').steps).toHaveLength(3);
  });

  it('one write per run at a time: changes meanwhile are written right after it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const book = new StepBook(dir);
    book.put('k', rec('a'));
    vi.advanceTimersByTime(2_000);
    book.put('k', rec('b'));
    vi.advanceTimersByTime(2_000);
    // The second came while the first was still writing: it waits for it.
    expect(writes.async).toBe(1);
    const has = (n: number) => {
      try {
        return saved(dir).steps.length === n;
      } catch {
        return false;
      }
    };
    await until(() => has(2));
    expect(saved(dir).steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(writes.async).toBe(2);
    expect(writes.sync).toBe(0);
  });

  it('a run read back and let go unchanged keeps its contents, its time brought up to now', async () => {
    const first = new StepBook(dir);
    first.put('k', rec('a'));
    first.flush('k');
    const file = path.join(dir, readdirSync(dir)[0]!);
    const text = readFileSync(file, 'utf8');
    utimesSync(file, new Date(1_000), new Date(1_000));
    writes.sync = 0;
    const again = new StepBook(dir);
    expect(again.page('k').steps).toHaveLength(1);
    again.flush('k');
    expect(writes.sync).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(statSync(file).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    // Gone meanwhile: written again.
    rmSync(file);
    again.flush('k');
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('lets go of the least recently used big runs past its memory budget, and reads them back whole', () => {
    const book = new StepBook(dir);
    const big = 'x'.repeat(2_500_000);
    for (const k of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) book.put(k, rec(`${k}-step`, { output: big }));
    const inMemory = (book as unknown as { runs: Map<string, unknown> }).runs;
    expect(inMemory.size).toBeLessThan(6);
    expect(inMemory.has('r6')).toBe(true);
    expect(inMemory.has('r1')).toBe(false);
    expect(book.get('r1', 'r1-step')?.output).toBe(big);
  });

  it('keeps every run in memory when it has nowhere to save them', () => {
    const book = new StepBook();
    const big = 'x'.repeat(2_500_000);
    for (const k of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) book.put(k, rec(`${k}-step`, { output: big }));
    expect(book.get('r1', 'r1-step')?.output).toBe(big);
  });

  it('still keeps only the newest runs on disk', async () => {
    for (let i = 0; i < 305; i++) writeFileSync(path.join(dir, `old-${String(i).padStart(3, '0')}.json`), '{}');
    for (let i = 0; i < 305; i++) utimesSync(path.join(dir, `old-${String(i).padStart(3, '0')}.json`), new Date(1_000 + i * 1000), new Date(1_000 + i * 1000));
    const book = new StepBook(dir);
    book.put('k', rec('a'));
    book.flush('k');
    await until(() => readdirSync(dir).filter((f) => f.endsWith('.json')).length === 300);
    const left = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(left).toHaveLength(300);
    expect(left).not.toContain('old-000.json');
    expect(left).toContain('old-304.json');
    expect(new StepBook(dir).page('k').steps).toHaveLength(1);
  });
});
