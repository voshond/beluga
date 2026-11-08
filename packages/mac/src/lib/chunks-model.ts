/**
 * The window's code chunks (the views it loads the first time they're opened), made so a chunk
 * that never arrives can't leave a view blank forever (#370). On Windows, after long uptime,
 * WebView2 can stop answering the app's own origin: an import() that was never loaded stays
 * pending with no error, and React waits on it for good. So each load gives up after a while (and
 * the view shows what happened, with a way back), the views are fetched early while the origin
 * still answers, and each stall is noted in the daemon's black box. No React here: tests load it.
 */

/** How long a chunk may take before the view says it didn't load. */
export const CHUNK_TIMEOUT_MS = 20_000;

/** What went wrong loading a chunk, for the black box. */
export interface ChunkProblem {
  /** `stalled`: no answer in time; `failed`: the load itself threw. */
  readonly kind: 'stalled' | 'failed';
  readonly chunk: string;
  /** How long it had been loading. */
  readonly ms: number;
  readonly message: string;
}

/** A chunk that didn't load: once seen, only reloading the window brings it back. */
export class ChunkLoadError extends Error {
  override readonly name = 'ChunkLoadError';
  constructor(
    readonly chunk: string,
    readonly stalled: boolean,
    message: string,
  ) {
    super(message);
  }
}

/** What each engine says when a dynamic import or Vite's preload of one fails. */
const FAILED_IMPORT = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

/** This error is a chunk that didn't load (ours, or the engine's own words for it). */
export function isChunkLoadError(err: unknown): boolean {
  if (err instanceof ChunkLoadError) return true;
  return err instanceof Error && FAILED_IMPORT.test(err.message);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Report = (problem: ChunkProblem) => void;
/** Problems seen before the window could tell the daemon (kept until it can, a few at most). */
const early: ChunkProblem[] = [];
const EARLY_MAX = 20;
let reporter: Report | undefined;

/** Note a problem (or keep it until a reporter is set). */
export function reportChunkProblem(problem: ChunkProblem): void {
  if (reporter) return reporter(problem);
  if (early.length < EARLY_MAX) early.push(problem);
}

/** Send chunk problems to `report` from now on (and those seen before); returns how to stop. */
export function onChunkProblem(report: Report): () => void {
  reporter = report;
  for (const p of early.splice(0)) report(p);
  return () => {
    if (reporter === report) reporter = undefined;
  };
}

export interface Chunk<T> {
  readonly name: string;
  /** Load it (once; later calls share the load), giving up after the timeout. */
  load(): Promise<T>;
}

export interface ChunkOptions {
  /** Fetch it early, while the window is idle (prefetchChunks); `first` before the others. */
  readonly prefetch?: boolean | 'first';
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const registry: Chunk<unknown>[] = [];
/** How many at the front were asked for `first`. */
let firsts = 0;

/** The chunks that are fetched early, in the order they were made. */
export const prefetchable = (): readonly Chunk<unknown>[] => registry;

/**
 * A chunk loaded by `importer`. Every load is raced against the timeout, so a view never waits on
 * it for good; the import itself is shared, so a prefetched chunk is there when the view asks.
 */
export function chunk<T>(name: string, importer: () => Promise<T>, opts: ChunkOptions = {}): Chunk<T> {
  const timeoutMs = opts.timeoutMs ?? CHUNK_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  let pending: Promise<T> | undefined;
  let began = 0;
  let noted = false;
  const note = (problem: ChunkProblem): void => {
    // One note per chunk: a view drawn again (or prefetch and the view both waiting) says it once.
    if (noted) return;
    noted = true;
    reportChunkProblem(problem);
  };
  const start = (): Promise<T> => {
    if (pending) return pending;
    began = now();
    const p = importer().catch((err: unknown) => {
      // A load that threw can be tried again (a stalled one is still pending, and stays shared).
      if (pending === p) pending = undefined;
      note({ kind: 'failed', chunk: name, ms: now() - began, message: errorText(err) });
      throw new ChunkLoadError(name, false, `This part of Beluga didn’t load (${errorText(err)})`);
    });
    pending = p;
    return p;
  };
  const made: Chunk<T> = {
    name,
    load() {
      const loading = start();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const ms = now() - began;
          note({ kind: 'stalled', chunk: name, ms, message: `no answer after ${Math.round(ms / 1000)} s` });
          reject(new ChunkLoadError(name, true, 'This part of Beluga didn’t finish loading'));
        }, timeoutMs);
      });
      return Promise.race([loading, late]).finally(() => clearTimeout(timer));
    },
  };
  if (opts.prefetch === 'first') registry.splice(firsts++, 0, made as Chunk<unknown>);
  else if (opts.prefetch) registry.push(made as Chunk<unknown>);
  return made;
}

/** Run `fn` when the window is idle (or soon, where there's no requestIdleCallback: WebKit). */
export function whenIdle(fn: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(fn, { timeout: 2000 });
  else setTimeout(fn, 50);
}

/**
 * Fetch the prefetchable chunks one at a time, each when the window is idle, so they're in the
 * module cache before the origin can stall (a chunk already loaded can't hang later). A problem
 * is noted by the chunk itself; prefetching just moves on.
 */
export async function prefetchChunks(chunks: readonly Chunk<unknown>[] = prefetchable(), idle: (fn: () => void) => void = whenIdle): Promise<void> {
  for (const c of chunks) {
    await new Promise<void>((resolve) => idle(resolve));
    await c.load().catch(() => undefined);
  }
}
