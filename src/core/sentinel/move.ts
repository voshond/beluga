import type { MetricMeta } from './metric-files.js';
import type { MetricLine } from './metrics.js';
import type { Dashboard, Tile } from './dashboard-model.js';
import type { RunSummary, Sentinel } from './model.js';
import type { SentinelTest } from './preview.js';

/**
 * A sentinel moving to another computer (BLG-807), as the daemons see it: its definition (steps,
 * trigger, schedule, access), its run history (with each run's report and outputs, within limits),
 * its kept numbers (every line) and the tiles that show only it on your dashboards. It lands paused
 * on the new computer, its sources checked there with that computer's variables; it's turned on
 * there only if it was on, its sources answer and nothing it uses is missing there. Browser-safe.
 */

export interface SentinelPackage {
  readonly version: 1;
  readonly sentinel: Sentinel;
  readonly runs: readonly RunSummary[];
  /** Each run's report and step outputs (by run id, then file name). */
  readonly files: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly metrics: ReadonlyArray<{ readonly name: string; readonly meta?: MetricMeta; readonly lines: readonly MetricLine[] }>;
  /** Its tiles, by the dashboard they're on (by name: dashboards are each computer's own). */
  readonly tiles: ReadonlyArray<{ readonly dashboard: string; readonly compare: Dashboard['compare']; readonly tiles: readonly Tile[] }>;
  /** What an event trigger saw last (so it doesn't fire again for what it saw here). */
  readonly cursor?: unknown;
  /** The variables it uses that are set here (names only): the new computer says which it lacks. */
  readonly needs: readonly string[];
  readonly project?: { readonly name: string; readonly origin?: string };
}

/** How it landed: its sources' check there, what it lacks there, and whether it can run on its own now. */
export interface SentinelLanding {
  readonly id: string;
  readonly name: string;
  readonly test?: SentinelTest;
  /** Variables it uses that aren't set there (names only). */
  readonly missing: readonly string[];
  /** Its sources answered there (or it has none to check). */
  readonly sourcesOk: boolean;
  /** It starts from a webhook: its address there is a new one. */
  readonly webhook: boolean;
  /** How many tiles came with it, and runs. */
  readonly tiles: number;
  readonly runs: number;
}

/** Whether a sentinel can move now: what's running, and its project. */
export interface SentinelMoveCheck {
  readonly running: boolean;
  readonly paused: boolean;
  readonly project?: { readonly name: string; readonly origin?: string };
}

/** The sentinels a tile shows. */
export function tileSentinels(t: Tile): string[] {
  return [t.metric?.sentinelId, ...(t.metrics ?? []).map((m) => m.sentinelId), t.step?.sentinelId, t.sentinelId].filter((x): x is string => Boolean(x));
}

/** The tiles that show this sentinel and no other, by dashboard (a tile with another's numbers too stays). */
export function tilesOf(dashboards: readonly Dashboard[], sentinelId: string): SentinelPackage['tiles'] {
  return dashboards.flatMap((d) => {
    const tiles = d.tiles.filter((t) => {
      const ids = tileSentinels(t);
      return ids.length > 0 && ids.every((x) => x === sentinelId);
    });
    return tiles.length ? [{ dashboard: d.name, compare: d.compare, tiles }] : [];
  });
}

const VAR = /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g;
/** Names a shell always has: never asked for. */
const ALWAYS = new Set(['HOME', 'PATH', 'USER', 'SHELL', 'PWD', 'TMPDIR', 'LANG']);

/** The variables a sentinel's steps name ($NAME in a script, a service call or a query; a source's own `env`). */
export function variablesOf(s: Sentinel): string[] {
  const text = JSON.stringify(s.steps);
  const named = [...text.matchAll(VAR)].map((m) => m[1]!);
  const own = s.steps.flatMap((st) => {
    const env = (st as { readonly source?: { readonly env?: unknown } }).source?.env;
    return typeof env === 'string' && /^[A-Z][A-Z0-9_]*$/.test(env) ? [env] : [];
  });
  return [...new Set([...named, ...own])].filter((n) => !ALWAYS.has(n)).sort();
}
