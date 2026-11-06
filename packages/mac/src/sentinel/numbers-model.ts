import type { Cell, Row } from '../../../../src/shared/view-spec.js';
import { type MetricColumn, isViewKind, storageSources } from '../../../../src/core/sentinel/columns.js';
import { type Dashboard, type MetricRef, type TileColumn, tileColumns, OUTPUT_STEP_KINDS, type StepRef, type Tile, type TileState, TILE_STATE_WORDS, metricOf, tileCompare, tileMetrics, tileOutput, tileStateIn, tileTitle } from '../../../../src/core/sentinel/dashboard-model.js';
import { COMPARE, COMPARE_LABEL, COMPARE_WORDS, type Compare, type Tone, changeText, deltaOf, formatMetric, unitLabel } from '../../../../src/core/sentinel/metrics.js';
import { type MetricKind, type MetricSeries, type SentinelState, STEP_INFO, type StepKind, firstLine } from '../../../../src/core/sentinel/model.js';

/**
 * Sentinel's dashboard on the Mac (docs/sentinel.md §10), the pure part: a number tile's words, a
 * series' rows (over time, or a kept array), the compare choices, the Refresh line, what Add a Tile
 * lists (metrics and steps), and the drafts an ask made. Tested from
 * tests/mac-dashboard.test.ts.
 */

export const COMPARE_CHOICES: ReadonlyArray<{ readonly value: Compare; readonly label: string; readonly hint: string }> = COMPARE.map((c) => ({ value: c, label: COMPARE_LABEL[c], hint: `Each change ${COMPARE_WORDS[c]}` }));

/** A number tile as drawn: its label, value, change, tone, what it's compared with, and its sparkline. */
export interface NumberWords {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly change?: string;
  readonly tone: Tone;
  readonly vs: string;
  readonly trend: readonly number[];
  /** The last point's run (the tile opens it). */
  readonly runId?: string;
  readonly at?: number;
}

export function numberWords(m: MetricSeries, compare: Compare, label = m.label): NumberWords {
  const last = m.points.at(-1);
  const d = deltaOf(m.points, compare, m.better);
  const change = changeText(d, m.unit);
  const unit = unitLabel(m.unit);
  return {
    label,
    value: last ? formatMetric(last.value, m.unit) : '—',
    ...(unit && m.unit !== 'percent' && !m.unit.startsWith('currency:') && m.unit !== 'ms' && m.unit !== 'bytes' ? { unit } : {}),
    ...(change ? { change } : {}),
    tone: d?.tone ?? 'none',
    vs: d?.change !== undefined ? COMPARE_WORDS[compare] : m.points.length > 1 ? `nothing ${COMPARE_WORDS[compare].replace(/^vs /, 'from ')}` : 'its first number',
    trend: m.points.slice(-30).map((p) => p.value),
    ...(last ? { runId: last.runId, at: last.at } : {}),
  };
}

/** A sentinel's numbers, in the order they were made (rows metrics after; series and outputs apart). */
export function metricsOf(s: Pick<SentinelState, 'metrics'>, sentinelId: string): { readonly numbers: MetricSeries[]; readonly tables: MetricSeries[]; readonly series: MetricSeries[]; readonly outputs: MetricSeries[] } {
  const all = Object.values(s.metrics?.[sentinelId] ?? {});
  return { numbers: all.filter((m) => m.kind === 'number'), tables: all.filter((m) => m.kind === 'rows'), series: all.filter((m) => m.kind === 'series'), outputs: all.filter((m) => m.kind === 'output') };
}

/** A series metric's kept array as a chart view's JSON (each point's label along the bottom). */
export function seriesViewOf(m: MetricSeries, kind: 'line' | 'area' | 'bar' = 'bar', height?: number): Record<string, unknown> {
  const type = m.unit.startsWith('currency:') ? 'currency' : m.unit === 'percent' ? 'percent' : m.unit === 'bytes' ? 'bytes' : 'number';
  return {
    type: 'chart',
    chart: kind,
    x: 'x',
    columns: [{ key: 'x', type: 'text', label: '' }, { key: 'y', label: m.label, type, ...(type === 'currency' ? { currency: m.unit.slice('currency:'.length) } : {}) }],
    series: [{ key: 'y', label: m.label }],
    data: (m.series ?? []).map((p) => ({ x: p.x, y: p.y, runId: m.rowsRunId ?? '' })),
    curve: 'smooth',
    legend: false,
    ...(height ? { height } : {}),
  };
}

/** A chart's rows: one per point in time, a column per metric (`m0`, `m1`…), with the run each came from. */
export function chartRows(series: readonly MetricSeries[]): { readonly rows: Row[]; readonly keys: ReadonlyArray<{ readonly key: string; readonly label: string }> } {
  const byAt = new Map<number, Record<string, Cell>>();
  series.forEach((m, i) => {
    for (const p of m.points) {
      const row = byAt.get(p.at) ?? { at: new Date(p.at).toISOString() };
      row[`m${i}`] = p.value;
      row[`run${i}`] = p.runId;
      if (row.runId === undefined) row.runId = p.runId;
      byAt.set(p.at, row);
    }
  });
  return { rows: [...byAt.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r), keys: series.map((m, i) => ({ key: `m${i}`, label: m.label })) };
}

/** A chart view's JSON for some metrics over time (the chat's `line` / `area` / `bar` view). */
export function chartViewOf(series: readonly MetricSeries[], kind: 'line' | 'area' | 'bar' = 'line', height?: number): Record<string, unknown> {
  const { rows, keys } = chartRows(series);
  const m = series[0];
  const type = m?.unit.startsWith('currency:') ? 'currency' : m?.unit === 'percent' ? 'percent' : m?.unit === 'bytes' ? 'bytes' : 'number';
  return {
    type: 'chart',
    chart: kind,
    x: 'at',
    columns: [{ key: 'at', type: 'datetime', label: 'When' }, ...keys.map((k) => ({ key: k.key, label: k.label, type, ...(type === 'currency' && m ? { currency: m.unit.slice('currency:'.length) } : {}) }))],
    series: keys.map((k) => ({ key: k.key, label: k.label })),
    data: rows,
    curve: 'smooth',
    legend: keys.length > 1,
    ...(height ? { height } : {}),
  };
}

/**
 * A rows metric as a table view's JSON (pages of 8). Each column as its sentinel typed it (BLG-381):
 * its heading, and the kind the table draws it as (a column with no type is guessed from its values,
 * as before). A tile's own order, headings and hidden columns win (BLG-347); a storage chip's bucket
 * and path columns stay out of sight unless the tile names them.
 */
export function tableViewOf(m: Pick<MetricSeries, 'rows' | 'columns' | 'columnTypes'>, pageSize = 8, own?: readonly TileColumn[]): Record<string, unknown> {
  const present = m.columns?.length ? m.columns : Object.keys(m.rows?.[0] ?? {});
  const typed = new Map((m.columnTypes ?? []).map((c) => [c.key, c]));
  const quiet = new Set(storageSources(m.columnTypes, present));
  const columns = tileColumns(present, own).map((c) => {
    const t = typed.get(c.key);
    const label = c.label ?? t?.label;
    const hidden = c.hidden || (quiet.has(c.key) && !own?.some((o) => o.key === c.key));
    return { key: c.key, ...(label ? { label } : {}), ...(hidden ? { hidden: true } : {}), ...(t ? viewTypeOf(t) : {}) };
  });
  return { type: 'table', columns, data: m.rows ?? [], pageSize, search: false };
}

/** How the table draws a typed column: the chat's own kinds as they are; a document or a rich kind as text (its cell draws it). */
function viewTypeOf(t: MetricColumn): Record<string, unknown> {
  if (!isViewKind(t.type)) return { type: 'text' };
  return { type: t.type, ...(t.currency ? { currency: t.currency } : {}), ...(t.decimals !== undefined ? { decimals: t.decimals } : {}) };
}

/** The typed columns a table draws itself (documents, storage, and the kinds only a kept table has), by key. */
export function drawnColumns(m: Pick<MetricSeries, 'columnTypes'>): ReadonlyMap<string, MetricColumn> {
  return new Map((m.columnTypes ?? []).filter((c) => !isViewKind(c.type)).map((c) => [c.key, c]));
}

/** The metric's own row a table's row stands for (a typed action runs with it; the daemon checks it again). */
export function keptRow(rows: readonly Row[] | undefined, row: Readonly<Record<string, unknown>>): Row | undefined {
  return rows?.find((r) => Object.keys(r).every((k) => (r[k] ?? null) === (row[k] ?? null)));
}

/** JSON as pretty text for the tree (a ```json block, the chat's JSON tree). */
export function jsonFence(text: string): string {
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Shown as it came.
  }
  return `\`\`\`json\n${pretty}\n\`\`\``;
}

/** Rows of a JSON list for an output tile's table: each cell as text or a number. */
export function outputTable(rows: ReadonlyArray<Record<string, unknown>>): { readonly rows: Array<Record<string, string | number | boolean | null>>; readonly columns: string[] } {
  const columns = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))].slice(0, 12);
  const cell = (v: unknown): string | number | boolean | null => (v === null || v === undefined ? null : typeof v === 'number' || typeof v === 'boolean' ? v : typeof v === 'string' ? v : JSON.stringify(v));
  return { columns, rows: rows.slice(0, 200).map((r) => Object.fromEntries(columns.map((c) => [c, cell(r[c])]))) };
}

/** "Fetching… 2 of 3" (the one going is the next: 0 done means the first is running). */
export const refreshLine = (r: { readonly done: number; readonly total: number } | undefined): string | undefined => (r ? `Fetching… ${Math.min(r.total, r.done + 1)} of ${r.total}` : undefined);

/** What a tile can't draw from, in its quiet words (none: it draws). */
export const tileNote = (state: TileState): string | undefined => (state === 'ok' ? undefined : TILE_STATE_WORDS[state]);

/** What a tile is, for its menu and the sheet: "Revenue · Stripe revenue". */
export function tileCaption(s: Pick<SentinelState, 'metrics' | 'items'>, t: Tile): { readonly title: string; readonly from?: string; readonly state: TileState } {
  const ref = t.metric ?? t.metrics?.[0];
  const sid = ref?.sentinelId ?? t.sentinelId;
  const from = sid ? s.items.find((i) => i.id === sid)?.name : undefined;
  return { title: tileTitle(s, t), ...(from ? { from } : {}), state: tileStateIn(s, t) };
}

/** One choice in Add a Tile: a sentinel's metric, under its project. */
export interface MetricChoice {
  readonly ref: MetricRef;
  readonly label: string;
  readonly sentinel: string;
  readonly project: string;
  readonly kind: MetricKind;
  readonly value?: string;
  readonly onIt: boolean;
}

/** One step Add a Tile's output picks from: what a Claude, service or script step said last. */
export interface StepChoice {
  readonly ref: StepRef;
  readonly label: string;
  readonly kind: StepKind;
  readonly sentinel: string;
  readonly project: string;
  readonly hint: string;
}

/** Every step an output tile can show, by project then sentinel. */
export function stepChoices(s: Pick<SentinelState, 'items'>, projectName: (id: string | undefined) => string): StepChoice[] {
  return s.items
    .flatMap((i) => i.steps.filter((st) => OUTPUT_STEP_KINDS.has(st.kind)).map((st): StepChoice => ({ ref: { sentinelId: i.id, stepId: st.id }, label: st.name, kind: st.kind, sentinel: i.name, project: projectName(i.projectId), hint: st.kind === 'claude' ? 'What the agent wrote, as Markdown' : st.kind === 'http' ? 'The service’s answer, as a JSON tree or a table' : 'What the script printed' })))
    .sort((a, b) => a.project.localeCompare(b.project) || a.sentinel.localeCompare(b.sentinel));
}

/** The sentinels your Claude made for a dashboard's ask that are still drafts (never turned on): the banner's. */
export function draftsOf(s: Pick<SentinelState, 'items' | 'dashboardAsks' | 'runs'>, dashboardId: string): Array<{ readonly id: string; readonly name: string }> {
  const made = s.dashboardAsks?.[dashboardId]?.made ?? [];
  return made.flatMap((id) => {
    const sn = s.items.find((i) => i.id === id);
    return sn && sn.paused && !s.runs.some((r) => r.sentinelId === id) ? [{ id: sn.id, name: sn.name }] : [];
  });
}

/** What an output tile says it is, under its title: "Read what changed · Morning brief" (the step's kind when it has no name). */
export const stepLabel = (kind: StepKind): string => STEP_INFO[kind].label;

/** Every metric to pick from, by project then sentinel, with whether this dashboard has it already. */
export function metricChoices(s: Pick<SentinelState, 'metrics' | 'items'>, projectName: (id: string | undefined) => string, d?: Dashboard): MetricChoice[] {
  const on = new Set((d?.tiles ?? []).flatMap((t) => [...(t.metric ? [t.metric] : []), ...(t.metrics ?? [])]).map((r) => `${r.sentinelId}/${r.metric}`));
  return s.items
    .flatMap((i) =>
      Object.values(s.metrics?.[i.id] ?? {}).map((m): MetricChoice => {
        const last = m.points.at(-1);
        return {
          ref: { sentinelId: i.id, metric: m.name },
          label: m.label,
          sentinel: i.name,
          project: projectName(i.projectId),
          kind: m.kind,
          ...(m.kind === 'rows' ? { value: `${m.rows?.length ?? 0} rows` } : m.kind === 'series' ? { value: `${m.series?.length ?? 0} points` } : m.kind === 'output' ? { value: m.output?.format === 'json' ? 'JSON' : m.output?.format === 'markdown' ? 'Markdown' : 'text' } : last ? { value: formatMetric(last.value, m.unit) } : {}),
          onIt: on.has(`${i.id}/${m.name}`),
        };
      }),
    )
    .sort((a, b) => a.project.localeCompare(b.project) || a.sentinel.localeCompare(b.sentinel));
}

/** The number tiles a dashboard draws, worked out (Copy as Markdown, the phone's Home row). */
export function tileWords(s: Pick<SentinelState, 'metrics' | 'items' | 'runs'> & Partial<Pick<SentinelState, 'outputs'>>, d: Dashboard, t: Tile): { readonly title: string; readonly value?: string; readonly change?: string; readonly text?: string } {
  const title = tileTitle(s, t);
  if (t.kind === 'number') {
    const m = metricOf(s, t.metric);
    if (!m) return { title };
    const w = numberWords(m, tileCompare(d, t));
    return { title, value: w.value, ...(w.change ? { change: `${w.change} ${w.vs}` } : {}) };
  }
  if (t.kind === 'text') {
    const last = [...s.runs].reverse().find((r) => r.sentinelId === t.sentinelId);
    return { title, ...(last?.headline ? { text: last.headline } : {}) };
  }
  if (t.kind === 'table') {
    const m = metricOf(s, t.metric);
    return { title, ...(m?.rows ? { value: `${m.rows.length} rows` } : {}) };
  }
  if (t.kind === 'series') {
    const ms = tileMetrics(s, t);
    const kept = ms[0]?.kind === 'series' ? ms[0] : undefined;
    if (kept) return { title, value: (kept.series ?? []).slice(0, 14).map((p) => `${p.x} ${formatMetric(p.y, kept.unit)}`).join(', ') };
    return { title, ...(ms.length ? { value: ms.map((m) => `${m.label} ${m.points.at(-1) ? formatMetric(m.points.at(-1)!.value, m.unit) : '—'}`).join(', ') } : {}) };
  }
  if (t.kind === 'output') {
    const o = tileOutput(s as Pick<SentinelState, 'metrics' | 'outputs'>, t);
    return { title, ...(o ? { text: o.format === 'json' ? jsonFence(o.text) : o.format === 'markdown' ? o.text : firstLine(o.text, 400) } : {}) };
  }
  return { title };
}

// ---------------------------------------------------------------- Add to the board (BLG-308)

/** How a picked thing can show on the board, as the sheet's pictures say it. */
export type TileLook = 'number' | 'line' | 'bars' | 'table' | 'text';
export const LOOK_WORDS: Readonly<Record<TileLook, string>> = { number: 'A number', line: 'Over time', bars: 'Bars', table: 'A table', text: 'Its text' };

/** The looks a kept thing fits: a number as itself or over time, a kept array as a chart, rows as a table, words as text. */
export function looksFor(kind: MetricKind | 'step' | 'report'): readonly TileLook[] {
  if (kind === 'number') return ['number', 'line', 'bars'];
  if (kind === 'series') return ['line', 'bars'];
  if (kind === 'rows') return ['table'];
  return ['text'];
}

/** The sizes as shapes: how many of the six columns, and whether tall. */
export const TILE_SIZES = [
  { id: 'small', label: 'Small', w: 1, h: 1 },
  { id: 'wide', label: 'Wide', w: 2, h: 1 },
  { id: 'half', label: 'Half', w: 3, h: 1 },
  { id: 'big', label: 'Big', w: 3, h: 2 },
  { id: 'full', label: 'Full width', w: 6, h: 1 },
] as const;
export type TileSizeId = (typeof TILE_SIZES)[number]['id'];

/** The size a look starts at: a number small, a chart or a table half, text big. */
export const sizeFor = (look: TileLook): TileSizeId => (look === 'number' ? 'small' : look === 'text' ? 'big' : 'half');

/** Somewhere a tile can come from that no sentinel fetches yet: Claude sets one up (a draft) when you pick it. */
export const NEW_SOURCES = [
  { id: 'github', label: 'GitHub', hint: 'pull requests, issues, CI', ideas: ['Open pull requests', 'Open issues', 'Failed CI runs this week'] },
  { id: 'database', label: 'A database', hint: 'Supabase, Postgres, SQLite', ideas: ['Sign-ups per day', 'Rows added yesterday', 'The latest 10 orders'] },
  { id: 'url', label: 'A URL or an API', hint: 'any JSON', ideas: ['A number from a JSON API', 'Whether my site answers'] },
  { id: 'script', label: 'A script', hint: 'prints a number', ideas: ['Free disk space', 'Lines of code'] },
] as const;
export type NewSourceId = (typeof NEW_SOURCES)[number]['id'];

/** What Claude is asked when you pick somewhere new and say what from it. */
export const newSourceAsk = (source: NewSourceId, words: string): string => `Add a tile from ${NEW_SOURCES.find((x) => x.id === source)!.label}: ${words.trim()}. If no sentinel fetches it yet, set one up (a draft) that does.`;
