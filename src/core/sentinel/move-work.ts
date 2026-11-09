import { z } from 'zod';
import { MoveTransfers } from '../move-transfer.js';
import type { Store } from '../store.js';
import { tryGit } from '../../workspaces/git.js';
import type { Dashboards } from './dashboards.js';
import type { RunFolders } from './files.js';
import type { MetricFiles } from './metric-files.js';
import type { RunSummary, Sentinel } from './model.js';
import { type SentinelLanding, type SentinelMoveCheck, type SentinelPackage, tilesOf, variablesOf } from './move.js';
import { type SentinelTest, previewBroken } from './preview.js';

/**
 * A sentinel moving between your computers (BLG-807), each daemon's part. Your app runs the move
 * (src/machines/move-sentinel.ts): check → pack here → land there, paused, its sources checked
 * with that computer's variables → gone from here (its tiles with it) → on there, if it was on and
 * nothing stands in the way. Landing takes everything in or leaves nothing there.
 */

/** What the move reaches inside Sentinels (Sentinels.movePort). */
export interface SentinelMovePort {
  readonly get: (id: string) => Sentinel | undefined;
  readonly count: () => number;
  readonly max: number;
  readonly runsOf: (id: string) => readonly RunSummary[];
  readonly running: (id: string) => boolean;
  readonly folders: RunFolders;
  readonly metricFiles: MetricFiles;
  readonly dashboards: Dashboards;
  readonly cursor: (id: string) => unknown;
  /** The variables a sentinel in this project sees here (names and values; only names leave). */
  readonly env: (projectId: string | undefined) => Record<string, string>;
  readonly adopt: (item: Sentinel, runs: readonly RunSummary[], cursor: unknown) => void;
  readonly test: (id: string) => Promise<SentinelTest>;
  readonly setWhy: (id: string, why: string) => void;
  readonly remove: (id: string) => void;
}

/** A run's files that go along: its report and its steps' outputs, within these limits. */
const RUN_FILE = /^(report\.md|step-\d{1,3}\.txt)$/;
const MAX_RUN_FILE = 1024 * 1024;
const MAX_RUN_FILES = 24 * 1024 * 1024;

const Package = z
  .object({
    version: z.literal(1),
    sentinel: z.object({ id: z.string().min(1).max(60), name: z.string(), trigger: z.object({ kind: z.string() }).passthrough(), steps: z.array(z.unknown()) }).passthrough(),
    runs: z.array(z.object({ id: z.string(), sentinelId: z.string(), state: z.string() }).passthrough()).max(2000),
    files: z.record(z.string(), z.record(z.string().regex(RUN_FILE), z.string())),
    metrics: z.array(z.object({ name: z.string().min(1).max(200), meta: z.unknown().optional(), lines: z.array(z.object({ at: z.number(), runId: z.string() }).passthrough()) })).max(200),
    tiles: z.array(z.object({ dashboard: z.string().min(1).max(60), compare: z.string(), tiles: z.array(z.object({ id: z.string(), kind: z.string() }).passthrough()).max(60) })).max(30),
    cursor: z.unknown().optional(),
    needs: z.array(z.string().max(100)).max(200),
    project: z.object({ name: z.string(), origin: z.string().optional() }).optional(),
  })
  .passthrough();

export class SentinelMover {
  private readonly transfers: MoveTransfers;

  constructor(
    private readonly port: SentinelMovePort,
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    this.transfers = new MoveTransfers(now);
  }

  private need(id: string): Sentinel {
    const s = this.port.get(id);
    if (!s) throw new Error(`There's no sentinel ${id}`);
    return s;
  }

  /** Whether it runs now, whether it's paused, and its project (for the other computer to find). */
  async check(id: string): Promise<SentinelMoveCheck> {
    const s = this.need(id);
    const project = await this.project(s.projectId);
    return { running: this.port.running(s.id), paused: s.paused, ...(project ? { project } : {}) };
  }

  /** Packed to go (nothing here changes): refused while it runs. */
  async pack(id: string): Promise<SentinelPackage> {
    const s = this.need(id);
    if (this.port.running(s.id)) throw new Error(`“${s.name}” is running now: let it finish (or stop it) first`);
    const runs = this.port.runsOf(s.id);
    const files: Record<string, Record<string, string>> = {};
    let total = 0;
    for (const r of [...runs].reverse()) {
      for (const name of ['report.md', ...r.steps.map((_, i) => `step-${i + 1}.txt`)]) {
        const text = this.port.folders.read(r.id, name);
        if (text === undefined || text.length > MAX_RUN_FILE || total + text.length > MAX_RUN_FILES) continue;
        files[r.id] = { ...files[r.id], [name]: text };
        total += text.length;
      }
    }
    const meta = this.port.metricFiles.meta(s.id);
    const names = this.port.metricFiles.list().find((m) => m.sentinelId === s.id)?.names ?? [];
    const metrics = names.map((name) => ({ name, ...(meta[name] ? { meta: meta[name] } : {}), lines: this.port.metricFiles.read(s.id, name) }));
    const env = this.port.env(s.projectId);
    const project = await this.project(s.projectId);
    const cursor = this.port.cursor(s.id);
    return {
      version: 1,
      sentinel: s,
      runs,
      files,
      metrics,
      tiles: tilesOf(this.port.dashboards.list(), s.id),
      ...(cursor !== undefined ? { cursor } : {}),
      needs: variablesOf(s).filter((n) => env[n] !== undefined),
      ...(project ? { project } : {}),
    };
  }

  packOut = async (id: string): Promise<{ readonly token: string; readonly chunks: number }> => this.transfers.send(await this.pack(id), 'This sentinel');
  chunk = (token: string, n: number): string => this.transfers.chunk(token, n);
  receive = (token: string, n: number, total: number, data: string): void => this.transfers.receive(token, n, total, data);

  /** Every piece is in: landed here (see land). */
  landIn(token: string, projectId: string | null, from: string): Promise<SentinelLanding> {
    const pkg = Package.safeParse(this.transfers.take(token));
    if (!pkg.success) throw new Error('What came over isn’t a sentinel this Beluga can read (update Beluga on both computers)');
    return this.land(pkg.data as unknown as SentinelPackage, projectId ?? undefined, from);
  }

  /**
   * Landed here, paused (in `projectId`, or none): its runs and their files, its numbers, its tiles
   * on the dashboards of the same names; then its sources checked here, and what it lacks here said.
   */
  async land(pkg: SentinelPackage, projectId: string | undefined, from: string): Promise<SentinelLanding> {
    const was = pkg.sentinel;
    if (this.port.get(was.id)) throw new Error(`“${was.name}” is here already`);
    if (this.port.count() >= this.port.max) throw new Error(`Up to ${this.port.max} sentinels here: delete one you don’t need first`);
    if (projectId && !this.store.getState().projects.some((p) => p.id === projectId)) throw new Error('That project isn’t here');
    const at = this.now();
    const { projectId: _p, pausedWhy: _w, ...rest } = was;
    const item: Sentinel = { ...rest, ...(projectId ? { projectId } : {}), paused: true, pausedWhy: `Moved here from ${from}`, failures: 0, lastScheduledAt: at, updatedAt: at };
    let tiles = 0;
    try {
      for (const [runId, named] of Object.entries(pkg.files)) for (const [name, text] of Object.entries(named)) this.port.folders.write(runId, name, text);
      for (const m of pkg.metrics) {
        if (m.meta) this.port.metricFiles.setMeta(was.id, m.name, m.meta);
        this.port.metricFiles.putAll(was.id, m.name, m.lines);
      }
      this.port.adopt(item, pkg.runs, pkg.cursor);
      for (const t of pkg.tiles) tiles += this.port.dashboards.putTiles(t.dashboard, t.compare, t.tiles).tiles.length;
    } catch (err) {
      if (this.port.get(was.id)) this.drop(was.id);
      else this.port.metricFiles.remove(was.id);
      throw err;
    }
    // Its sources, checked here with this computer's variables (a failed check doesn't undo the move: it waits paused).
    const test = await this.port.test(was.id).catch(() => undefined);
    const env = this.port.env(projectId);
    const missing = pkg.needs.filter((n) => env[n] === undefined);
    const sourcesOk = !test || !test.previews.some(previewBroken);
    const why = missing.length ? `Moved here from ${from}: it needs ${missing.join(', ')} here` : !sourcesOk ? `Moved here from ${from}: its sources didn’t answer here` : undefined;
    if (why) this.port.setWhy(was.id, why);
    return { id: was.id, name: was.name, ...(test ? { test } : {}), missing, sourcesOk, webhook: was.trigger.kind === 'webhook', tiles, runs: pkg.runs.length };
  }

  /** It runs on the other computer now (or a landed copy whose move didn't finish): gone from here, with the tiles that showed only it. */
  drop(id: string): void {
    const ids = new Set(tilesOf(this.port.dashboards.list(), id).flatMap((d) => d.tiles.map((t) => t.id)));
    if (ids.size) this.port.dashboards.dropTiles(ids);
    if (this.port.get(id)) this.port.remove(id);
  }

  private async project(projectId: string | undefined): Promise<{ readonly name: string; readonly origin?: string } | undefined> {
    const p = projectId ? this.store.getState().projects.find((x) => x.id === projectId) : undefined;
    if (!p) return undefined;
    const origin = p.root ? (await tryGit(p.root, ['remote', 'get-url', 'origin']))?.trim() : undefined;
    return { name: p.name, ...(origin ? { origin } : {}) };
  }
}
