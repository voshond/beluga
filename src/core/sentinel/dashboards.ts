import { randomBytes } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { readJson, writeJson } from '../../net/mesh/files.js';
import { type Dashboard, DEFAULT_WIDTH, MAX_DASHBOARDS, MAX_TILES, type MetricInfo, type Tile, autoTiles, moveTile, placeTile } from './dashboard-model.js';
import type { Compare } from './metrics.js';
import { DashboardFileSchema, SavedDashboardSchema, TileInputSchema, type TilePatchSchema } from './schema.js';

/**
 * Your dashboards (docs/sentinel.md §10) in ~/.beluga/dashboards.json (yours only, written
 * atomically a moment after a change): made, renamed, their tiles added, changed, moved and
 * removed; the first one made for you when the first number arrives (once: one you delete isn't
 * made again). `changed` hears every change (the state). Memory only without a folder.
 */

export type TileInput = z.input<typeof TileInputSchema>;
export type TilePatch = z.input<typeof TilePatchSchema>;

const short = (prefix: string): string => `${prefix}_${randomBytes(5).toString('hex')}`;

export class Dashboards {
  private items: Dashboard[] = [];
  /** The first one was made for you already. */
  private made = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readOnly = false;

  constructor(
    private readonly dir: string | null,
    private readonly now: () => number,
    private readonly changed: (all: readonly Dashboard[]) => void,
    private readonly delayMs = 300,
  ) {
    this.load();
  }

  get file(): string | undefined {
    return this.dir ? path.join(this.dir, 'dashboards.json') : undefined;
  }

  list = (): readonly Dashboard[] => this.items;

  get(ref: string): Dashboard | undefined {
    return this.items.find((d) => d.id === ref) ?? this.items.find((d) => d.name.toLowerCase() === ref.trim().toLowerCase());
  }

  need(ref: string): Dashboard {
    const d = this.get(ref);
    if (!d) throw new Error(`There's no dashboard ${ref}`);
    return d;
  }

  create(name: string, tiles: readonly Tile[] = [], extra: Partial<Pick<Dashboard, 'auto' | 'compare'>> = {}): Dashboard {
    if (this.items.length >= MAX_DASHBOARDS) throw new Error(`Up to ${MAX_DASHBOARDS} dashboards: delete one you don’t need first`);
    const at = this.now();
    const d: Dashboard = { id: short('db'), name: oneLine(name, 60) || 'Dashboard', compare: extra.compare ?? 'previous', tiles: tiles.slice(0, MAX_TILES), ...(extra.auto ? { auto: true } : {}), createdAt: at, updatedAt: at };
    this.items = [...this.items, d];
    this.made = true;
    this.save();
    return d;
  }

  update(ref: string, patch: { readonly name?: string; readonly compare?: Compare }): Dashboard {
    const was = this.need(ref);
    return this.replace({ ...was, ...(patch.name !== undefined ? { name: oneLine(patch.name, 60) || was.name } : {}), ...(patch.compare ? { compare: patch.compare } : {}) });
  }

  remove(ref: string): void {
    const d = this.need(ref);
    this.items = this.items.filter((x) => x.id !== d.id);
    this.save();
  }

  /** A tile, checked and given its id and width. */
  addTile(ref: string, input: TileInput, at?: number): { readonly dashboard: Dashboard; readonly tile: Tile } {
    const d = this.need(ref);
    if (d.tiles.length >= MAX_TILES) throw new Error(`Up to ${MAX_TILES} tiles on a dashboard`);
    const tile = tileOf(input);
    const tiles = [...d.tiles];
    tiles.splice(at === undefined ? tiles.length : Math.max(0, Math.min(at, tiles.length)), 0, tile);
    return { dashboard: this.replace({ ...d, tiles }), tile };
  }

  updateTile(ref: string, tileId: string, patch: TilePatch): Dashboard {
    const d = this.need(ref);
    const was = d.tiles.find((t) => t.id === tileId);
    if (!was) throw new Error(`“${d.name}” has no tile ${tileId}`);
    const { compare, ...rest } = patch;
    const { compare: _c, ...without } = was;
    const merged = { ...(compare === null ? without : was), ...stripUndefined(rest), ...(compare ? { compare } : {}) };
    const next = tileOf(merged as TileInput);
    return this.replace({ ...d, tiles: d.tiles.map((t) => (t.id === tileId ? next : t)) });
  }

  removeTile(ref: string, tileId: string): Dashboard {
    const d = this.need(ref);
    if (!d.tiles.some((t) => t.id === tileId)) throw new Error(`“${d.name}” has no tile ${tileId}`);
    return this.replace({ ...d, tiles: d.tiles.filter((t) => t.id !== tileId) });
  }

  /**
   * Dragged into place: to a spot (a column and a row; a tile there goes below it, every other
   * stays put), or to `index` among the others (the board flows in that order again).
   */
  moveTile(ref: string, tileId: string, to: number | { readonly col: number; readonly row: number }): Dashboard {
    const d = this.need(ref);
    if (!d.tiles.some((t) => t.id === tileId)) throw new Error(`“${d.name}” has no tile ${tileId}`);
    if (typeof to === 'number') return this.replace({ ...d, tiles: moveTile(d.tiles, tileId, to).map(({ col: _c, row: _r, ...t }) => t) });
    return this.replace({ ...d, tiles: placeTile(d.tiles, tileId, to.col, to.row) });
  }

  /**
   * Tiles that came with a sentinel from another computer (BLG-807): on the dashboard of that name
   * here (made when there's none), after its own, each with an id of its own here, flowing in order.
   * → the dashboard and the tiles' ids here (to take them off again).
   */
  putTiles(name: string, compare: Compare, tiles: readonly Tile[]): { readonly dashboard: string; readonly tiles: readonly string[] } {
    const d = this.get(name) ?? this.create(name, [], { compare });
    const room = Math.max(0, MAX_TILES - d.tiles.length);
    const added = tiles.slice(0, room).map(({ col: _c, row: _r, ...t }) => ({ ...t, id: short('tl') }));
    this.replace({ ...d, tiles: [...d.tiles, ...added] });
    return { dashboard: d.id, tiles: added.map((t) => t.id) };
  }

  /** Tiles taken off where they were (their sentinel moved away with them). */
  dropTiles(ids: ReadonlySet<string>): void {
    for (const d of this.items) if (d.tiles.some((t) => ids.has(t.id))) this.replace({ ...d, tiles: d.tiles.filter((t) => !ids.has(t.id)) });
  }

  /** The first number arrived: the first dashboard, with every number as a tile (once, ever). */
  autoMake(metrics: readonly MetricInfo[]): Dashboard | undefined {
    if (this.made || this.items.length || !metrics.length) return undefined;
    return this.create('Everything', autoTiles(metrics, () => short('tl')), { auto: true });
  }

  /** Everything written now (on the way out). */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.write();
  }

  private replace(next: Dashboard): Dashboard {
    const d = { ...next, updatedAt: this.now() };
    this.items = this.items.map((x) => (x.id === d.id ? d : x));
    this.save();
    return d;
  }

  private load(): void {
    const file = this.file;
    if (!file || !existsSync(file)) return;
    const parsed = DashboardFileSchema.safeParse(readJson(file));
    if (!parsed.success) {
      try {
        renameSync(file, `${file}.unreadable-${this.now()}`);
      } catch {
        this.readOnly = true;
      }
      return;
    }
    this.made = parsed.data.made;
    this.items = parsed.data.dashboards.flatMap((raw) => {
      const r = SavedDashboardSchema.safeParse(raw);
      return r.success ? [r.data as unknown as Dashboard] : [];
    });
    if (this.items.length < parsed.data.dashboards.length) {
      try {
        writeJson(path.join(this.dir!, `dashboards.dropped-${this.now()}.json`), parsed.data.dashboards.filter((raw) => !SavedDashboardSchema.safeParse(raw).success));
      } catch {
        this.readOnly = true;
      }
    }
  }

  private save(): void {
    this.changed(this.items);
    if (!this.dir || this.readOnly) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, this.delayMs);
    this.timer.unref?.();
  }

  private write(): void {
    const file = this.file;
    if (!file) return;
    try {
      writeJson(file, { version: 1, made: this.made, dashboards: this.items });
    } catch {
      // A full disk: the next change tries again.
    }
  }
}

/** A tile from what was given: checked, with its id, its kind's width, and what its kind needs. */
export function tileOf(input: TileInput): Tile {
  const t = TileInputSchema.parse(input);
  const base = { id: t.id ?? short('tl'), kind: t.kind, width: t.width ?? DEFAULT_WIDTH[t.kind], ...(t.height === 2 && t.kind !== 'divider' ? { height: 2 as const } : {}), ...(t.row !== undefined ? { col: t.kind === 'divider' ? 0 : (t.col ?? 0), row: t.row } : {}), ...(t.title?.trim() ? { title: oneLine(t.title, 80) } : {}), ...(t.compare && t.kind !== 'divider' ? { compare: t.compare } : {}) };
  switch (t.kind) {
    case 'number':
    case 'table':
      if (!t.metric) throw new Error(`A ${t.kind === 'number' ? 'number' : 'table'} tile needs its metric (a sentinel and a metric’s name)`);
      // An empty list gives the columns back to the rows.
      return { ...base, metric: t.metric, ...(t.kind === 'table' && t.columns?.length ? { columns: t.columns.map((c) => ({ key: c.key, ...(c.label?.trim() ? { label: oneLine(c.label, 80) } : {}), ...(c.hidden ? { hidden: true } : {}) })) } : {}) };
    case 'series': {
      // Several metrics over time, or one (a number's points, or a series metric's kept array).
      const metrics = t.metrics?.length ? t.metrics : t.metric ? [t.metric] : [];
      if (!metrics.length) throw new Error('A series tile needs one metric or more');
      return { ...base, ...(metrics.length === 1 && !t.metrics?.length ? { metric: metrics[0]! } : { metrics }), chart: t.chart ?? 'line' };
    }
    case 'output':
      if (t.step) return { ...base, step: t.step, ...(t.show && t.show !== 'auto' ? { show: t.show } : {}) };
      if (t.metric) return { ...base, metric: t.metric, ...(t.show && t.show !== 'auto' ? { show: t.show } : {}) };
      throw new Error('An output tile needs its step (a sentinel and one of its steps) or an output metric');
    case 'text':
      if (!t.sentinelId) throw new Error('A text tile needs its sentinel');
      return { ...base, sentinelId: t.sentinelId, text: t.text ?? 'headline' };
    case 'divider':
      return { ...base, width: 6 };
  }
}

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const stripUndefined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
