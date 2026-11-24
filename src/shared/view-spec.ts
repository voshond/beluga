import { z } from 'zod';

/**
 * `beluga-view`: the live elements Claude shows you (a fenced block of JSON in an answer, or what
 * the `show` tool puts there): tables, charts, stat tiles, code and colors. Claude brings the data,
 * or says how to fetch it (a file, a folder, a database, a web address, a command), and the window
 * draws it with its own pieces: "next page", sorting, search and refresh fetch more without Claude.
 * Only data, never code that runs in the window. A source runs on the computer of the Claude that
 * wrote it, and only for that computer's owner (everyone else sees the rows it came with).
 * Browser-safe: the Mac app parses it, the core runs sources and teaches Claude the format.
 * Spec and examples: docs/views.md.
 */

export const VIEW_FENCE = 'beluga-view';
export const VIEW_TYPES = ['table', 'chart', 'stats', 'code', 'colors', 'gantt', 'heatmap', 'calendar'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

/** `beluga-view`, or a type's own tag (`beluga-table`, `beluga-chart`…) that says which it is. */
export function viewFenceType(lang: string | undefined): ViewType | 'any' | undefined {
  if (!lang) return undefined;
  if (lang === VIEW_FENCE) return 'any';
  const m = /^beluga-(\w+)$/.exec(lang);
  return m && (VIEW_TYPES as readonly string[]).includes(m[1]!) ? (m[1] as ViewType) : undefined;
}
export const isViewFence = (lang: string | undefined): boolean => viewFenceType(lang) !== undefined;

export const COLUMN_TYPES = ['text', 'number', 'percent', 'currency', 'bytes', 'date', 'datetime', 'bool', 'url', 'path', 'color', 'image', 'code', 'badge'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
export const CHART_KINDS = ['line', 'area', 'bar', 'pie', 'donut', 'scatter'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
export const CURVES = ['smooth', 'linear', 'step'] as const;
export const SOURCE_KINDS = ['file', 'folder', 'sqlite', 'postgres', 'bigquery', 'http', 'command'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const DATA_FORMATS = ['auto', 'json', 'jsonl', 'csv', 'tsv', 'lines', 'text'] as const;
export type DataFormat = (typeof DATA_FORMATS)[number];

export const MAX_INLINE_ROWS = 500;
export const MAX_COLUMNS = 40;
/** The most rows a source may bring back in one go (the rest is paged, or cut). */
export const MAX_SOURCE_ROWS = 50_000;

export type Cell = string | number | boolean | null;
export type Row = Readonly<Record<string, Cell>>;

const clip = (max: number) => z.string().transform((v) => (v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v));
const short = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .transform((v) => (v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v));
// Near-misses read kindly ("Line", "smoothed", "int").
const kindOf = <T extends string>(all: readonly T[], aliases: Readonly<Record<string, T>>, fallback: T) =>
  z
    .string()
    .optional()
    .transform((v): T => {
      const k = (v ?? '').trim().toLowerCase();
      return (all as readonly string[]).includes(k) ? (k as T) : Object.hasOwn(aliases, k) ? aliases[k]! : fallback;
    });

const COLUMN_ALIASES: Readonly<Record<string, ColumnType>> = {
  string: 'text',
  int: 'number',
  integer: 'number',
  float: 'number',
  decimal: 'number',
  money: 'currency',
  price: 'currency',
  size: 'bytes',
  time: 'datetime',
  timestamp: 'datetime',
  boolean: 'bool',
  link: 'url',
  file: 'path',
  colour: 'color',
  picture: 'image',
  status: 'badge',
  tag: 'badge',
};

const columnSchema = z.preprocess(
  (raw) => (typeof raw === 'string' ? { key: raw } : raw),
  z.object({
    key: short(80),
    label: clip(80).optional(),
    type: kindOf(COLUMN_TYPES, COLUMN_ALIASES, 'text').optional(),
    /** Digits after the point; a currency's code ("EUR"); a unit after the number ("ms"). */
    decimals: z.number().int().min(0).max(8).optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    unit: clip(12).optional(),
    align: z.enum(['left', 'right', 'center']).optional(),
    hidden: z.boolean().optional(),
  }),
);
export type Column = Omit<z.infer<typeof columnSchema>, 'type'> & { readonly type: ColumnType };

const cell = z.union([z.string().max(20_000), z.number(), z.boolean(), z.null()]);
const json = z.unknown();

const common = {
  /** How long a command or request may run (seconds). */
  timeout: z.number().int().min(1).max(120).optional(),
  /** What the output is ("auto" reads JSON, JSON lines, CSV or TSV, else one row per line). */
  format: kindOf(DATA_FORMATS, { ndjson: 'jsonl', table: 'tsv', txt: 'text', raw: 'text' }, 'auto'),
  /** Where the rows are in a JSON answer: "data.items" (dots and [0]). */
  rows: clip(200).optional(),
};
const path = z.string().trim().min(1).max(4096);
const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path, ...common }),
  z.object({
    kind: z.literal('folder'),
    path,
    /** Only names like this ("*.png", "**\/*.ts"). */
    glob: clip(200).optional(),
    recursive: z.boolean().optional(),
    hidden: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('sqlite'), path, query: z.string().trim().min(1).max(20_000) }),
  z.object({
    kind: z.literal('postgres'),
    /** The name of an environment variable holding the connection string (keeps the password out of the chat). */
    env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200).optional(),
    url: z.string().max(2000).optional(),
    query: z.string().trim().min(1).max(20_000),
    /** The folder whose project's variables (and .env) hold the connection string. Neither env nor url: found there. */
    cwd: z.string().max(4096).optional(),
  }),
  z.object({
    kind: z.literal('bigquery'),
    /** The name of an environment variable holding a service account's key (JSON). Unset: GOOGLE_APPLICATION_CREDENTIALS_JSON, then BIGQUERY_CREDENTIALS. */
    env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200).optional(),
    query: z.string().trim().min(1).max(20_000),
    /** The project the job runs (and is billed) in. Unset: the key's own. */
    project: z.string().regex(/^[a-z][a-z0-9.:-]{3,100}$/).optional(),
    /** Where the data is ("EU", "US", "europe-west3"). Unset: BigQuery finds it from the tables. */
    location: z.string().regex(/^[A-Za-z0-9-]{2,40}$/).optional(),
    /** The most a query may bill, in GB (1 when unset). */
    maxGb: z.number().positive().max(1000).optional(),
    /** The folder whose project's variables (and .env) hold the key. */
    cwd: z.string().max(4096).optional(),
  }),
  z.object({
    kind: z.literal('http'),
    url: z.string().trim().url().max(4000),
    method: z.enum(['GET', 'POST']).default('GET'),
    headers: z.record(z.string().max(200), z.string().max(4000)).optional(),
    body: z.string().max(100_000).optional(),
    ...common,
  }),
  z.object({ kind: z.literal('command'), command: z.string().trim().min(1).max(8000), cwd: z.string().max(4096).optional(), ...common }),
]);
/** A source plus how often to fetch it again (seconds; 0: only when asked). */
const liveSource = z.preprocess(
  (raw) => {
    if (typeof raw === 'string') return { kind: 'command', command: raw };
    if (!raw || typeof raw !== 'object') return raw;
    const s = raw as Record<string, unknown>;
    if (s.kind !== undefined) return raw;
    // A source without its kind says what it is by what it has.
    const kind = s.url && !s.query ? 'http' : s.command ? 'command' : s.query ? (s.env || s.url ? 'postgres' : 'sqlite') : s.glob || s.recursive ? 'folder' : s.path ? 'file' : undefined;
    return kind ? { ...s, kind } : raw;
  },
  z.intersection(sourceSchema, z.object({ refresh: z.number().min(0).max(86_400).optional() })),
);
export type Source = z.infer<typeof sourceSchema> & { readonly refresh?: number };
/** A source as it crosses to the core (the window asks for a page of it). */
export const SourceSchema = liveSource;
export type CommandSource = Extract<Source, { kind: 'command' }>;

/** A button on the element: open a link, copy something, or show a different source in it. */
const actionSchema = z.object({
  label: short(40),
  href: z.string().max(4000).optional(),
  copy: z.string().max(20_000).optional(),
  source: liveSource.optional(),
});
export type ViewAction = z.infer<typeof actionSchema>;

const seriesSchema = z.preprocess(
  (raw) => (typeof raw === 'string' ? { key: raw } : raw),
  z.object({ key: short(80), label: clip(80).optional(), color: clip(40).optional(), type: z.enum(['line', 'area', 'bar']).optional() }),
);
export type Series = z.infer<typeof seriesSchema>;

const statSchema = z.object({
  label: short(60),
  value: z.union([z.number(), clip(40)]),
  /** The change: 12.5 or "+12.5%"; "down" is good when `invert`. */
  delta: z.union([z.number(), clip(24)]).optional(),
  deltaLabel: clip(40).optional(),
  invert: z.boolean().optional(),
  trend: z.array(z.number()).max(400).optional(),
  hint: clip(120).optional(),
  status: z.enum(['good', 'warning', 'serious', 'critical']).optional(),
  type: kindOf(COLUMN_TYPES, COLUMN_ALIASES, 'text').optional(),
  unit: clip(12).optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
});
export type Stat = z.infer<typeof statSchema>;

const colorSchema = z.preprocess(
  (raw) => (typeof raw === 'string' ? { value: raw } : raw),
  z.object({ value: z.string().trim().min(1).max(80), name: clip(60).optional(), note: clip(120).optional() }),
);
export type Swatch = z.infer<typeof colorSchema>;

/** Inline data: rows of objects, rows of arrays (with `columns`), or CSV/TSV/JSON text. */
const dataSchema = z.union([z.array(json).max(MAX_INLINE_ROWS * 4), z.string().max(400_000), z.object({ columns: z.array(json).optional(), rows: z.array(json) })]);

// ---- controls: what the user can change without asking Claude again

export const CONDITION_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
const OP_ALIASES: Readonly<Record<string, ConditionOp>> = { '=': 'eq', '==': 'eq', is: 'eq', '!=': 'ne', not: 'ne', '>': 'gt', '>=': 'gte', min: 'gte', '<': 'lt', '<=': 'lte', max: 'lte', has: 'contains', like: 'contains', includes: 'contains', oneof: 'in' };
const opOf = kindOf(CONDITION_OPS, OP_ALIASES, 'eq');
const conditionSchema = z.object({ key: short(80), op: opOf, value: z.union([cell, z.array(cell).max(200)]) });
export type Condition = { key: string; op: ConditionOp; value: Cell | Cell[] };
const sortSchema = z.preprocess(
  (raw) => (typeof raw === 'string' ? { key: raw.replace(/^-/, ''), dir: raw.startsWith('-') ? 'desc' : 'asc' } : raw),
  z.object({ key: short(80), dir: kindOf(['asc', 'desc'] as const, { ascending: 'asc', descending: 'desc', up: 'asc', down: 'desc' }, 'asc') }),
);
/** What choosing something does to the rows: sort them, keep the first N, keep those matching, search, fill the source's {{slots}}, or show another source. */
const patch = {
  sort: sortSchema.optional(),
  top: z.number().int().min(1).max(MAX_SOURCE_ROWS).optional(),
  where: z.array(conditionSchema).max(12).optional(),
  search: z.string().max(200).optional(),
  params: z.record(z.string().max(60), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
  source: liveSource.optional(),
};
const optionSchema = z.preprocess(
  (raw) => (typeof raw === 'string' || typeof raw === 'number' ? { label: String(raw), value: raw } : raw),
  z.object({ label: short(40), value: cell.optional(), ...patch }),
);
export const CONTROL_TYPES = ['buttons', 'select', 'toggle', 'number', 'range', 'search'] as const;
export type ControlType = (typeof CONTROL_TYPES)[number];
const controlSchema = z.object({
  id: short(60),
  type: kindOf(CONTROL_TYPES, { segmented: 'buttons', tabs: 'buttons', button: 'buttons', radio: 'buttons', chips: 'buttons', dropdown: 'select', menu: 'select', choice: 'select', checkbox: 'toggle', switch: 'toggle', boolean: 'toggle', slider: 'range', input: 'search', text: 'search', filter: 'search', limit: 'number' }, 'buttons'),
  label: clip(40).optional(),
  /** The column it filters (a select without options offers the column's values). */
  column: clip(80).optional(),
  op: opOf.optional(),
  options: z.array(optionSchema).max(24).optional(),
  default: cell.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  placeholder: clip(60).optional(),
  /** A number that keeps only the first N rows ("Show top N"). */
  as: z.enum(['top', 'param']).optional(),
  ...patch,
});
export type ControlOption = z.infer<typeof optionSchema>;
export type Control = z.infer<typeof controlSchema>;
export type QueryPatch = { readonly sort?: { readonly key: string; readonly dir: 'asc' | 'desc' }; readonly top?: number; readonly where?: Condition[]; readonly search?: string; readonly params?: Readonly<Record<string, string | number | boolean>>; readonly source?: Source };

const viewSchema = z.object({
  version: z.literal(1).optional(),
  type: kindOf(VIEW_TYPES, { grid: 'table', list: 'table', graph: 'chart', plot: 'chart', kpi: 'stats', metrics: 'stats', snippet: 'code', palette: 'colors', colours: 'colors', timeline: 'gantt', roadmap: 'gantt', schedule: 'gantt', matrix: 'heatmap', heat: 'heatmap', activity: 'calendar', contributions: 'calendar', days: 'calendar' }, 'table'),
  title: clip(120).optional(),
  summary: clip(400).optional(),
  columns: z.array(columnSchema).max(MAX_COLUMNS).optional(),
  data: dataSchema.optional(),
  source: liveSource.optional(),
  /** Rows per page (tables), how many a source brings at first. */
  pageSize: z.number().int().min(1).max(500).optional(),
  /** The total the source said it had (or Claude counted), shown before the first fetch. */
  total: z.number().int().min(0).optional(),
  actions: z.array(actionSchema).max(8).optional(),
  /** Buttons, menus, toggles, numbers and search that change the rows right away (no Claude in between). */
  controls: z.array(controlSchema).max(10).optional(),
  /** Applied before anything is chosen (a sort, a top N, a filter). */
  initial: z.object(patch).optional(),
  /** When the rows were fetched (ms since 1970), for "as of". */
  at: z.number().optional(),
  // ---- table
  search: z.boolean().optional(),
  /** A column whose value each row opens (a URL or a path). */
  link: clip(80).optional(),
  // ---- chart
  chart: kindOf(CHART_KINDS, { lines: 'line', spline: 'line', timeseries: 'line', column: 'bar', columns: 'bar', bars: 'bar', histogram: 'bar', ring: 'donut', doughnut: 'donut', dots: 'scatter', points: 'scatter' }, 'line').optional(),
  x: clip(80).optional(),
  y: z.union([seriesSchema, z.array(seriesSchema).max(12)]).optional(),
  /** Long rows ({day, service, count}): one series per value of this column. */
  group: clip(80).optional(),
  curve: kindOf(CURVES, { smoothed: 'smooth', monotone: 'smooth', curved: 'smooth', straight: 'linear', steps: 'step', stepped: 'step' }, 'smooth').optional(),
  stacked: z.boolean().optional(),
  horizontal: z.boolean().optional(),
  dots: z.boolean().optional(),
  legend: z.boolean().optional(),
  grid: z.boolean().optional(),
  height: z.number().int().min(120).max(800).optional(),
  colors: z.array(clip(40)).max(12).optional(),
  yLabel: clip(40).optional(),
  xLabel: clip(40).optional(),
  // ---- stats
  items: z.array(statSchema).max(12).optional(),
  // ---- code
  code: z.string().max(200_000).optional(),
  language: clip(30).optional(),
  filename: clip(200).optional(),
  highlight: z.array(z.number().int().min(1)).max(400).optional(),
  startLine: z.number().int().min(1).optional(),
  // ---- colors
  swatches: z.array(colorSchema).max(64).optional(),
  pick: z.boolean().optional(),
  // ---- gantt (a bar per row from "start" to "end", in lanes by "group"), heatmap ("x" × "y" by
  // "value"), calendar (a day grid of "value" by date)
  /** The column naming each row (a gantt's bar, a calendar day's words). */
  label: clip(80).optional(),
  start: clip(80).optional(),
  end: clip(80).optional(),
  /** A gantt bar's progress (0–1, or a percent). */
  progress: clip(80).optional(),
  /** The column whose number colors a heatmap's cell or a calendar's day. */
  value: clip(80).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** A gantt's line at today (on unless false). */
  today: z.boolean().optional(),
});
type RawView = z.infer<typeof viewSchema>;

export interface View {
  readonly type: ViewType;
  readonly title?: string;
  readonly summary?: string;
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
  readonly text?: string;
  readonly source?: Source;
  readonly pageSize: number;
  readonly total?: number;
  readonly at?: number;
  readonly actions: readonly ViewAction[];
  readonly controls: readonly Control[];
  readonly initial?: QueryPatch;
  readonly search: boolean;
  readonly link?: string;
  readonly chart: ChartKind;
  readonly x?: string;
  readonly series: readonly Series[];
  readonly group?: string;
  readonly curve: (typeof CURVES)[number];
  readonly stacked: boolean;
  readonly horizontal?: boolean;
  readonly dots?: boolean;
  readonly legend?: boolean;
  readonly grid: boolean;
  readonly height?: number;
  readonly colors?: readonly string[];
  readonly xLabel?: string;
  readonly yLabel?: string;
  readonly items: readonly Stat[];
  readonly language?: string;
  readonly filename?: string;
  readonly highlight: readonly number[];
  readonly startLine: number;
  readonly swatches: readonly Swatch[];
  readonly pick: boolean;
  readonly label?: string;
  readonly start?: string;
  readonly end?: string;
  readonly progress?: string;
  readonly value?: string;
  readonly min?: number;
  readonly max?: number;
  readonly today: boolean;
}

export type ViewParse =
  | { readonly ok: true; readonly view: View; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly incomplete: boolean };

function pathOf(p: readonly PropertyKey[]): string {
  return p.map((k, i) => (typeof k === 'number' ? `[${k}]` : `${i ? '.' : ''}${String(k)}`)).join('');
}

/** Whether JSON text stops part-way (a block still being written), rather than being wrong. */
export function looksUnfinished(text: string): boolean {
  const open: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') open.push(c === '{' ? '}' : ']');
    else if ((c === '}' || c === ']') && open.pop() !== c) return false;
  }
  return inString || open.length > 0;
}

/** Read a view from parsed JSON (the tool's input, or a block's). `type`: what the fence said. */
export function readView(raw: unknown, type?: ViewType): ViewParse {
  const given = type && raw && typeof raw === 'object' && !Array.isArray(raw) ? { type, ...(raw as object) } : Array.isArray(raw) ? { type: type ?? 'table', data: raw } : raw;
  // A chart "of kind" heatmap, gantt or calendar is that view.
  const asked = given && typeof given === 'object' ? (given as { chart?: unknown }).chart : undefined;
  const input = typeof asked === 'string' && /^(heatmap|gantt|timeline|calendar)$/i.test(asked) ? { ...(given as object), type: asked.toLowerCase() === 'timeline' ? 'gantt' : asked.toLowerCase(), chart: undefined } : given;
  const parsed = viewSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? pathOf(issue.path) : '';
    return { ok: false, error: `${where ? `${where}: ` : ''}${issue?.message ?? 'not a view'}`, incomplete: false };
  }
  return tidy(parsed.data);
}

/** A block's JSON → a view that's safe to draw. Small mistakes are dropped with a warning. */
export function parseView(text: string, type?: ViewType): ViewParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // A table can come as CSV or TSV text in the block itself.
    if ((type === 'table' || type === 'chart') && !/^\s*[[{]/.test(text)) return readView({ data: text }, type);
    if (type === 'code') return readView({ code: text }, type);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Not valid JSON: ${message}`, incomplete: looksUnfinished(text) };
  }
  return readView(raw, type);
}

function tidy(v: RawView): ViewParse {
  const warnings: string[] = [];
  const { rows, columns: found } = v.data === undefined ? { rows: [], columns: [] } : toRows(v.data, v.columns);
  if (rows.length > MAX_INLINE_ROWS) warnings.push(`${rows.length - MAX_INLINE_ROWS} rows past ${MAX_INLINE_ROWS} are left out`);
  const kept = rows.slice(0, MAX_INLINE_ROWS);
  const columns = mergeColumns(v.columns ?? [], found, kept);
  const series = v.y === undefined ? [] : Array.isArray(v.y) ? v.y : [v.y];
  const type = v.type;
  const swatches = v.swatches ?? (type === 'colors' ? kept.flatMap((r) => swatchOf(r)) : []);
  const items = v.items ?? [];
  if (type === 'code' && v.code === undefined && !v.source) return { ok: false, error: 'a code view needs "code" or a "source"', incomplete: false };
  if (type === 'colors' && !swatches.length && !v.pick) return { ok: false, error: 'a colors view needs "swatches"', incomplete: false };
  if (type === 'stats' && !items.length && !kept.length && !v.source) return { ok: false, error: 'a stats view needs "items"', incomplete: false };
  if ((type === 'table' || type === 'chart' || type === 'gantt' || type === 'heatmap' || type === 'calendar') && !kept.length && !v.source) return { ok: false, error: `a ${type} needs "data" or a "source"`, incomplete: false };
  const view: View = {
    type,
    ...(v.title ? { title: v.title } : {}),
    ...(v.summary ? { summary: v.summary } : {}),
    columns,
    rows: kept,
    ...(v.code !== undefined ? { text: v.code } : {}),
    ...(v.source ? { source: v.source as Source } : {}),
    pageSize: v.pageSize ?? (type === 'table' ? 10 : type === 'calendar' ? 500 : 200),
    ...(v.total !== undefined ? { total: v.total } : {}),
    ...(v.at !== undefined ? { at: v.at } : {}),
    actions: v.actions ?? [],
    controls: v.controls ?? [],
    ...(v.initial ? { initial: v.initial as QueryPatch } : {}),
    search: v.search ?? true,
    ...(v.link ? { link: v.link } : {}),
    chart: v.chart ?? 'line',
    ...(v.x ? { x: v.x } : {}),
    series,
    ...(v.group ? { group: v.group } : {}),
    curve: v.curve ?? 'smooth',
    stacked: v.stacked ?? false,
    ...(v.horizontal !== undefined ? { horizontal: v.horizontal } : {}),
    ...(v.dots !== undefined ? { dots: v.dots } : {}),
    ...(v.legend !== undefined ? { legend: v.legend } : {}),
    grid: v.grid ?? true,
    ...(v.height ? { height: v.height } : {}),
    ...(v.colors?.length ? { colors: v.colors } : {}),
    ...(v.xLabel ? { xLabel: v.xLabel } : {}),
    ...(v.yLabel ? { yLabel: v.yLabel } : {}),
    items,
    ...(v.language ? { language: v.language } : {}),
    ...(v.filename ? { filename: v.filename } : {}),
    highlight: v.highlight ?? [],
    startLine: v.startLine ?? 1,
    swatches,
    pick: v.pick ?? false,
    ...(v.label ? { label: v.label } : {}),
    ...(v.start ? { start: v.start } : {}),
    ...(v.end ? { end: v.end } : {}),
    ...(v.progress ? { progress: v.progress } : {}),
    ...(v.value ? { value: v.value } : {}),
    ...(v.min !== undefined ? { min: v.min } : {}),
    ...(v.max !== undefined ? { max: v.max } : {}),
    today: v.today ?? true,
  };
  return { ok: true, view, warnings };
}

function swatchOf(r: Row): Swatch[] {
  const value = Object.values(r).find((c) => typeof c === 'string' && looksLikeColor(c));
  if (typeof value !== 'string') return [];
  const name = r.name ?? r.label ?? r.title;
  return [{ value, ...(typeof name === 'string' ? { name } : {}) }];
}

// ---------------------------------------------------------------- data: text and JSON → rows

/** A cell as it can be drawn: objects and arrays become their JSON. */
export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Rows from anything a source or Claude gives: objects, arrays (with columns), scalars or text. */
export function toRows(data: unknown, columns?: readonly { key: string }[], format: DataFormat = 'auto'): { rows: Row[]; columns: string[] } {
  if (typeof data === 'string') return parseText(data, format);
  if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as { rows?: unknown }).rows)) {
    const d = data as { rows: unknown[]; columns?: unknown[] };
    const cols = (d.columns ?? []).map((c) => (typeof c === 'string' ? { key: c } : c && typeof c === 'object' && 'key' in c ? { key: String((c as { key: unknown }).key) } : c && typeof c === 'object' && 'name' in c ? { key: String((c as { name: unknown }).name) } : { key: String(c) }));
    return toRows(d.rows, cols.length ? cols : columns);
  }
  if (!Array.isArray(data)) return data && typeof data === 'object' ? toRows([data], columns) : { rows: [], columns: [] };
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (k: string): void => {
    if (!seen.has(k) && keys.length < MAX_COLUMNS) (seen.add(k), keys.push(k));
  };
  const named = columns?.map((c) => c.key) ?? [];
  named.forEach(add);
  const rows: Row[] = [];
  for (const item of data) {
    if (Array.isArray(item)) {
      const header = named.length ? named : item.map((_, i) => (i === 0 && !named.length ? 'value' : `col${i + 1}`));
      header.forEach(add);
      const row: Record<string, Cell> = {};
      header.forEach((k, i) => (row[k] = toCell(item[i])));
      rows.push(row);
    } else if (item && typeof item === 'object') {
      const row: Record<string, Cell> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        add(k);
        if (seen.has(k)) row[k] = toCell(v);
      }
      rows.push(row);
    } else {
      add('value');
      rows.push({ value: toCell(item) });
    }
  }
  return { rows, columns: keys };
}

/** A path into JSON: "data.items", "results[0].rows", "" for all of it. */
export function pick(data: unknown, at: string | undefined): unknown {
  if (!at) return autoRows(data);
  let now: unknown = data;
  for (const part of at.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (now === null || typeof now !== 'object') return undefined;
    now = Object.hasOwn(now, part) ? (now as Record<string, unknown>)[part] : undefined;
  }
  return now;
}

/** An answer with one array in it (`{data: [...]}`, `{items: [...], total}`): that array. */
function autoRows(data: unknown): unknown {
  if (Array.isArray(data) || !data || typeof data !== 'object') return data;
  const arrays = Object.entries(data as Record<string, unknown>).filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'object');
  return arrays.length === 1 ? arrays[0]![1] : data;
}

/** The total an answer says it has (`total`, `count`, `total_count`), if any. */
export function totalOf(data: unknown): number | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  for (const k of ['total', 'total_count', 'totalCount', 'count', 'totalResults']) {
    const v = (data as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Text → rows: JSON, JSON lines, CSV, TSV, an aligned table (`ps`, `ls -l`), or one row per line. */
export function parseText(text: string, format: DataFormat = 'auto'): { rows: Row[]; columns: string[] } {
  const t = text.replace(/^﻿/, '');
  if (format === 'text') return { rows: [{ text: t }], columns: ['text'] };
  if (format === 'json' || (format === 'auto' && /^\s*[[{]/.test(t))) {
    try {
      return toRows(autoRows(JSON.parse(t)));
    } catch {
      if (format === 'json') throw new Error('The output isn’t valid JSON');
    }
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (format === 'jsonl' || (format === 'auto' && lines.length > 0 && lines.every((l) => /^\s*[{[]/.test(l)))) {
    try {
      return toRows(lines.map((l) => JSON.parse(l)));
    } catch {
      if (format === 'jsonl') throw new Error('The output isn’t valid JSON lines');
    }
  }
  if (format === 'lines') return toRows(lines.map((line) => ({ line })));
  const delim = format === 'csv' ? ',' : format === 'tsv' ? '\t' : guessDelimiter(lines);
  if (delim) {
    const table = parseDelimited(t, delim);
    const header = (table[0] ?? []).map((h, i) => h.trim() || `col${i + 1}`);
    return toRows(
      table.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, typed(cells[i] ?? '')]))),
      header.map((key) => ({ key })),
    );
  }
  const aligned = format === 'auto' ? alignedTable(lines) : undefined;
  if (aligned) return aligned;
  return toRows(lines.map((line) => ({ line })));
}

/** A cell read from text: numbers, booleans and empties as themselves. */
function typed(s: string): Cell {
  const t = s.trim();
  if (t === '') return null;
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) && !/^-?0\d/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  return s;
}

function guessDelimiter(lines: readonly string[]): string | undefined {
  const sample = lines.slice(0, 20);
  if (sample.length < 2) return undefined;
  for (const d of ['\t', ',', ';', '|']) {
    const counts = sample.map((l) => splitCount(l, d));
    if (counts[0]! > 0 && counts.every((c) => c === counts[0])) return d;
  }
  return undefined;
}
function splitCount(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === d && !q) n++;
  }
  return n;
}

/** RFC 4180-ish: quotes, doubled quotes, newlines inside quotes. */
export function parseDelimited(text: string, d: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cellText = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cellText += '"', i++);
      else if (c === '"') q = false;
      else cellText += c;
    } else if (c === '"' && cellText === '') q = true;
    else if (c === d) (row.push(cellText), (cellText = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cellText);
      cellText = '';
      if (row.some((x) => x !== '')) out.push(row);
      row = [];
    } else cellText += c;
  }
  row.push(cellText);
  if (row.some((x) => x !== '')) out.push(row);
  return out;
}

/** Columns lined up with spaces (a header, then rows): cut where every line has a gap. */
function alignedTable(lines: readonly string[]): { rows: Row[]; columns: string[] } | undefined {
  if (lines.length < 2 || lines.length > 5000) return undefined;
  const header = lines[0]!;
  const starts: number[] = [];
  const re = /\S+/g;
  for (let m = re.exec(header); m; m = re.exec(header)) starts.push(m.index);
  if (starts.length < 2 || !/\s{2,}|\t/.test(header) || /[^\w\s%#./()-]/.test(header)) return undefined;
  const names = starts.map((s, i) => header.slice(s, starts[i + 1] ?? undefined).trim());
  if (new Set(names).size !== names.length) return undefined;
  const rows = lines.slice(1).map((l) => {
    const parts = l.trim().split(/\s+/);
    // The last column takes what's left (a command line with spaces).
    const cells = [...parts.slice(0, names.length - 1), parts.slice(names.length - 1).join(' ')];
    return Object.fromEntries(names.map((n, i) => [n, typed(cells[i] ?? '')]));
  });
  return toRows(rows, names.map((key) => ({ key })));
}

// ---------------------------------------------------------------- columns: what each one holds

const DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const URL_RE = /^https?:\/\/\S+$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|heic)(\?.*)?$/i;
export const looksLikeColor = (s: string): boolean => /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s.trim()) || /^(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/i.test(s.trim());

/** What a column holds, from its name and values. */
export function inferType(key: string, values: readonly Cell[]): ColumnType {
  const vals = values.filter((v) => v !== null && v !== '').slice(0, 200);
  if (!vals.length) return 'text';
  const k = key.toLowerCase();
  const all = (f: (v: Cell) => boolean): boolean => vals.every(f);
  if (all((v) => typeof v === 'boolean')) return 'bool';
  if (all((v) => typeof v === 'number')) {
    if (/(^|_)(bytes|size)$|filesize/.test(k)) return 'bytes';
    if (/(percent|pct|ratio|rate)$/.test(k) && all((v) => Math.abs(v as number) <= 1)) return 'percent';
    if (/(price|cost|amount|revenue|usd|eur|total_\w*money)$/.test(k)) return 'currency';
    if (/(^|_)(at|time|ts|timestamp|date|modified|created|updated)$/.test(k) && all((v) => (v as number) > 9e11 && (v as number) < 5e12)) return 'datetime';
    return 'number';
  }
  const strs = vals.filter((v): v is string => typeof v === 'string');
  if (strs.length !== vals.length) return 'text';
  if (strs.every((s) => DATE.test(s.trim()))) return strs.some((s) => /\d{2}:\d{2}/.test(s)) ? 'datetime' : 'date';
  if (strs.every(looksLikeColor)) return 'color';
  if (strs.every((s) => IMAGE.test(s) && (URL_RE.test(s) || s.startsWith('/') || s.startsWith('~/')))) return 'image';
  if (strs.every((s) => URL_RE.test(s))) return 'url';
  if (strs.every((s) => (s.startsWith('/') || s.startsWith('~/')) && !/\s{2}/.test(s))) return 'path';
  if (/(^|_)(status|state|level|kind|type|tag|severity|priority)$/.test(k) && new Set(strs).size <= 12) return 'badge';
  return 'text';
}

/** What Claude said about the columns, over what the data shows (types filled in). */
export function mergeColumns(given: readonly z.infer<typeof columnSchema>[], found: readonly string[], rows: readonly Row[]): Column[] {
  const byKey = new Map(given.map((c) => [c.key, c]));
  const keys = given.length ? given.map((c) => c.key) : [...found];
  return keys.slice(0, MAX_COLUMNS).map((key) => {
    const c = byKey.get(key);
    return { ...c, key, type: c?.type ?? inferType(key, rows.map((r) => r[key] ?? null)) };
  });
}

/** Columns for rows a source brought (keeping what the view already said). */
export function columnsFor(view: Pick<View, 'columns'>, rows: readonly Row[], found: readonly string[]): Column[] {
  if (view.columns.length && view.columns.every((c) => found.includes(c.key) || !found.length)) return [...view.columns];
  const known = new Map(view.columns.map((c) => [c.key, c]));
  return found.slice(0, MAX_COLUMNS).map((key) => known.get(key) ?? { key, type: inferType(key, rows.map((r) => r[key] ?? null)) });
}

// ---------------------------------------------------------------- queries: sort, search, a page

export interface ViewQuery {
  readonly offset: number;
  readonly limit: number;
  readonly sort?: { readonly key: string; readonly dir: 'asc' | 'desc' };
  readonly search?: string;
  /** Column → text it must contain. */
  readonly filters?: Readonly<Record<string, string>>;
  /** Conditions from the view's controls. */
  readonly where?: Condition[];
  /** Only the first N rows (after sorting): "top 5". */
  readonly top?: number;
  /** Values for the source's {{slots}} (by control id). */
  readonly params?: Readonly<Record<string, string | number | boolean>>;
}
export const ViewQuerySchema = z.object({
  offset: z.number().int().min(0).max(10_000_000),
  limit: z.number().int().min(1).max(5000),
  sort: z.object({ key: z.string().max(80), dir: z.enum(['asc', 'desc']) }).optional(),
  search: z.string().max(200).optional(),
  filters: z.record(z.string().max(80), z.string().max(200)).optional(),
  where: z.array(z.object({ key: z.string().max(80), op: z.enum(CONDITION_OPS), value: z.union([cell, z.array(cell).max(200)]) })).max(24).optional(),
  top: z.number().int().min(1).max(MAX_SOURCE_ROWS).optional(),
  params: z.record(z.string().max(60), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
});

export interface ViewPage {
  readonly rows: readonly Row[];
  readonly columns: readonly string[];
  /** How many match (all of them, when known). */
  readonly total?: number;
  readonly hasMore: boolean;
  readonly at: number;
  /** A code view's text. */
  readonly text?: string;
  /** Sorting and searching happened at the source (a database, a templated command), or here. */
  readonly pushedDown?: boolean;
  readonly truncated?: boolean;
}

/** Fetching needs the owner's yes first (a command that hasn't run before). */
export interface ViewNeedsApproval {
  readonly needsApproval: true;
  readonly what: string;
}
/** Asked only for what was kept (`cache: 'only'`), and nothing was. */
export interface ViewNotKept {
  readonly notKept: true;
}
export type ViewFetchResult = ViewPage | ViewNeedsApproval | ViewNotKept;

export const compareCells = (a: Cell, b: Cell): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a ? -1 : 1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
};

/** Rows that match a search and filters, sorted (all of them, unpaged). */
export function queryRows(rows: readonly Row[], q: Omit<ViewQuery, 'offset' | 'limit'>): Row[] {
  const needle = q.search?.trim().toLowerCase();
  const filters = Object.entries(q.filters ?? {}).filter(([, v]) => v.trim());
  const where = q.where ?? [];
  let out = rows.filter((r) => {
    if (needle && !Object.values(r).some((v) => v !== null && String(v).toLowerCase().includes(needle))) return false;
    if (!where.every((c) => matches(r[c.key] ?? null, c))) return false;
    return filters.every(([k, v]) => String(r[k] ?? '').toLowerCase().includes(v.trim().toLowerCase()));
  });
  if (q.sort) {
    const { key, dir } = q.sort;
    // Empty cells stay last either way.
    out = [...out].sort((a, b) => {
      const [x, y] = [a[key] ?? null, b[key] ?? null];
      if (x === null || y === null) return compareCells(x, y);
      return (dir === 'asc' ? 1 : -1) * compareCells(x, y);
    });
  }
  return q.top ? out.slice(0, q.top) : out;
}

/** Whether a cell meets a control's condition (numbers as numbers, text without case). */
export function matches(c: Cell, cond: Condition): boolean {
  const { op, value } = cond;
  if (op === 'in') return Array.isArray(value) && value.some((v) => matches(c, { key: cond.key, op: 'eq', value: v }));
  if (Array.isArray(value)) return false;
  if (op === 'contains') return c !== null && String(c).toLowerCase().includes(String(value ?? '').toLowerCase());
  const num = (x: Cell): number | undefined => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : undefined);
  const [a, b] = [num(c), num(value as Cell)];
  const cmp = a !== undefined && b !== undefined ? a - b : c === null || value === null ? (c === value ? 0 : NaN) : String(c).localeCompare(String(value), undefined, { sensitivity: 'base', numeric: true });
  switch (op) {
    case 'eq':
      return cmp === 0;
    case 'ne':
      return cmp !== 0;
    case 'gt':
      return cmp > 0;
    case 'gte':
      return cmp >= 0;
    case 'lt':
      return cmp < 0;
    case 'lte':
      return cmp <= 0;
  }
}

/** One page of rows held here (inline data, or everything a source brought). */
export function pageOf(rows: readonly Row[], q: ViewQuery): Omit<ViewPage, 'columns' | 'at'> {
  const matched = queryRows(rows, q);
  return { rows: matched.slice(q.offset, q.offset + q.limit), total: matched.length, hasMore: q.offset + q.limit < matched.length };
}

/** A stable key for a source (the same source is fetched and approved once). */
export const sourceKey = (s: Source): string => JSON.stringify(s, Object.keys(s).sort());

/** What a source does, in a few words, for its button and the approval. */
export function describeSource(s: Source): string {
  switch (s.kind) {
    case 'file':
      return s.path;
    case 'folder':
      return `${s.path}${s.glob ? ` (${s.glob})` : ''}`;
    case 'sqlite':
      return `${s.path.split('/').pop()}: ${s.query}`;
    case 'postgres':
      return `${s.env ? `$${s.env}` : 'Postgres'}: ${s.query}`;
    case 'bigquery':
      return `${s.env ? `$${s.env}` : 'BigQuery'}: ${s.query}`;
    case 'http':
      return `${s.method} ${s.url}`;
    case 'command':
      return s.command;
  }
}

// ---------------------------------------------------------------- the block Claude writes

/** A view as a fenced block (what the `show` tool puts in an answer). */
export function viewBlock(json: unknown, fence = VIEW_FENCE): string {
  return '```' + fence + '\n' + JSON.stringify(json) + '\n```';
}
