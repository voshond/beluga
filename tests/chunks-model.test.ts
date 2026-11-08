import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_TIMEOUT_MS,
  ChunkLoadError,
  type ChunkProblem,
  chunk,
  isChunkLoadError,
  onChunkProblem,
  prefetchChunks,
  prefetchable,
  reportChunkProblem,
} from '../packages/mac/src/lib/chunks-model.js';

/** A chunk whose import never answers: what WebView2 does after long uptime (#370). */
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe('chunks (#370)', () => {
  let seen: ChunkProblem[];
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
    stop = onChunkProblem((p) => seen.push(p));
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('gives up on an import that never answers, instead of waiting for good', async () => {
    const c = chunk('views/ProjectHome', never<string>);
    const loading = c.load();
    const outcome = loading.then(
      () => 'loaded',
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(CHUNK_TIMEOUT_MS - 1);
    // Still waiting, as React's lazy would be: nothing settled yet.
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(ChunkLoadError);
    expect((err as ChunkLoadError).stalled).toBe(true);
    expect(isChunkLoadError(err)).toBe(true);
    expect(seen).toEqual([{ kind: 'stalled', chunk: 'views/ProjectHome', ms: CHUNK_TIMEOUT_MS, message: 'no answer after 20 s' }]);
  });

  it('loads once and shares it: a prefetched chunk is there when the view asks', async () => {
    const importer = vi.fn(() => Promise.resolve('Reader'));
    const c = chunk('views/reader/FileReader', importer);
    await expect(c.load()).resolves.toBe('Reader');
    await expect(c.load()).resolves.toBe('Reader');
    expect(importer).toHaveBeenCalledTimes(1);
    // A loaded chunk can't stall later: no timer left to fire.
    await vi.advanceTimersByTimeAsync(CHUNK_TIMEOUT_MS * 2);
    expect(seen).toEqual([]);
  });

  it('notes a failed import and lets the next load try again', async () => {
    const importer = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module: http://tauri.localhost/assets/x.js')).mockResolvedValue('ok');
    const c = chunk('views/DiffView', importer);
    const err = await c.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkLoadError);
    expect((err as ChunkLoadError).stalled).toBe(false);
    expect(seen.map((p) => [p.kind, p.chunk])).toEqual([['failed', 'views/DiffView']]);
    await expect(c.load()).resolves.toBe('ok');
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('notes a chunk once, however many times a view asks', async () => {
    const c = chunk('views/FilesView', never<string>);
    const a = c.load().catch(() => undefined);
    const b = c.load().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(CHUNK_TIMEOUT_MS);
    await Promise.all([a, b]);
    expect(seen).toHaveLength(1);
  });

  it('knows the engines’ own words for an import that failed', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });

  it('keeps problems seen before the window could report them', () => {
    stop();
    reportChunkProblem({ kind: 'failed', chunk: 'preload', ms: 0, message: 'early' });
    const later: ChunkProblem[] = [];
    stop = onChunkProblem((p) => later.push(p));
    expect(later.map((p) => p.message)).toEqual(['early']);
  });

  it('prefetches one chunk at a time, each when idle, and moves past one that stalls', async () => {
    const order: string[] = [];
    const stuck = chunk('stuck', () => (order.push('stuck'), never<string>()));
    const fine = chunk('fine', () => (order.push('fine'), Promise.resolve('ok')));
    const idle = vi.fn((fn: () => void) => void setTimeout(fn, 10));
    const done = prefetchChunks([stuck, fine], idle);
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(['stuck']);
    await vi.advanceTimersByTimeAsync(CHUNK_TIMEOUT_MS + 10);
    await done;
    expect(order).toEqual(['stuck', 'fine']);
    expect(idle).toHaveBeenCalledTimes(2);
    expect(seen.map((p) => p.chunk)).toEqual(['stuck']);
  });

  it('fetches the views the report was about before the rest', () => {
    const later = chunk('later', never<string>, { prefetch: true });
    const reader = chunk('reader', never<string>, { prefetch: 'first' });
    const home = chunk('home', never<string>, { prefetch: 'first' });
    chunk('not-fetched', never<string>);
    const names = prefetchable().map((c) => c.name);
    expect(names.slice(0, 2)).toEqual([reader.name, home.name]);
    expect(names).toContain(later.name);
    expect(names).not.toContain('not-fetched');
  });
});
