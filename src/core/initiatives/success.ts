import { z } from 'zod';

/**
 * What success means for an initiative (BLG-141): up to three metrics, each a query with its
 * attribution rule, a baseline from before delivery, a target and which way is good. Kept in the
 * initiative's success.json; the numbers themselves live with the sentinel it references. Browser-safe.
 */

export const SUCCESS_FILE = 'success.json';
export const SUCCESS_METRICS_MAX = 3;

export const SUCCESS_SOURCE_KINDS = ['bigquery', 'postgres'] as const;
export const SUCCESS_DIRECTIONS = ['up', 'down'] as const;
export type SuccessDirection = (typeof SUCCESS_DIRECTIONS)[number];
export const SUCCESS_UNITS = ['count', 'percent', 'ms', 'plain', 'currency:EUR', 'currency:USD'] as const;
export type SuccessUnit = (typeof SUCCESS_UNITS)[number];

export const SUCCESS_METRIC_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** A source as a definition keeps it: its kind, its query and a billing cap, never an address, a variable or a key. */
export const SuccessSourceSchema = z
  .object({
    kind: z.enum(SUCCESS_SOURCE_KINDS),
    query: z.string().trim().min(1).max(20_000),
    maxGb: z.number().positive().max(1000).optional(),
  })
  .strip();
export type SuccessSource = z.infer<typeof SuccessSourceSchema>;

const words = (max: number) => z.string().trim().max(max);

export const SuccessMetricSchema = z.object({
  name: z.string().regex(SUCCESS_METRIC_NAME),
  label: words(80).min(1),
  unit: z.enum(SUCCESS_UNITS).default('count'),
  direction: z.enum(SUCCESS_DIRECTIONS).default('up'),
  /** One row with a number in a column called `value`: the metric now. */
  source: SuccessSourceSchema,
  /** Which rows count as caused by this initiative, in words. */
  attribution: words(1000).min(1),
  /** The same rule as the query's filter (its WHERE part). */
  filter: words(2000).min(1),
  /** The same query over a window before delivery. */
  baselineQuery: z.string().trim().min(1).max(20_000),
  baselineWindow: words(200).default(''),
  baseline: z.preprocess((value) => value ?? undefined, z.number().finite().optional()),
  target: z.number().finite(),
});
export type SuccessMetric = z.infer<typeof SuccessMetricSchema>;
export type SuccessMetricInput = z.input<typeof SuccessMetricSchema>;

export const SuccessProposalSchema = z.object({
  summary: words(2000).min(1),
  /** What the agent wants the owner to know: where the repo and BigQuery disagreed, what it could not read. */
  notes: words(2000).optional(),
  /** The project whose variables the queries run with (one of the linked repos). */
  project: words(120).optional(),
  metrics: z.array(SuccessMetricSchema).min(1).max(SUCCESS_METRICS_MAX),
});
export type SuccessProposal = z.infer<typeof SuccessProposalSchema>;
export type SuccessProposalInput = z.input<typeof SuccessProposalSchema>;

export const SuccessDefinitionSchema = SuccessProposalSchema.extend({
  at: z.string().max(40),
  /** The sentinel that keeps the numbers, and the dashboard that shows them (both by id). */
  sentinel: z.string().max(80).optional(),
  dashboard: z.string().max(80).optional(),
  /** The ticket keys when it was accepted (none when no tickets were read yet): a change suggests revisiting it. */
  scope: z.array(z.string().max(40)).max(1000).optional(),
});
export type SuccessDefinition = z.infer<typeof SuccessDefinitionSchema>;

export const SuccessFileSchema = z.object({
  /** The day the status moved to Shipped (ISO), cleared when it moves back. */
  shippedAt: z.string().max(40).optional(),
  definition: SuccessDefinitionSchema.optional(),
});
export type SuccessFile = z.infer<typeof SuccessFileSchema>;

/** One metric's query, run once before the owner accepts: its first rows, or why it failed, and the baseline it found. */
export type SuccessPreview = {
  readonly metric: string;
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly value?: number;
  readonly baseline?: number;
  readonly error?: string;
};

export type SuccessDraft = {
  readonly proposal: SuccessProposal;
  readonly previews: readonly SuccessPreview[];
};

/** What the sentinel keeps for a metric (its names take hyphens, not underscores): the value, and baseline and target beside it so tiles can draw them. */
export const keptNames = (name: string): { readonly value: string; readonly baseline: string; readonly target: string } => {
  const base = name.replace(/_/g, '-');
  return { value: base, baseline: `${base}-baseline`, target: `${base}-target` };
};

const literal = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12))));

/** The query the sentinel keeps: the metric's own, with its baseline and target as columns beside `value`. */
export const keptQuery = (metric: Pick<SuccessMetric, 'source' | 'target'>, baseline: number): string => {
  const inner = metric.source.query.trim().replace(/;+\s*$/, '');
  return `SELECT v.value AS value, ${literal(baseline)} AS baseline, ${literal(metric.target)} AS target FROM (${inner}) AS v`;
};

/** The number in a result's `value` column (first row), or the only number when there's no such column. */
export const valueOf = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>): number | undefined => {
  const first = rows[0];
  if (!first) return undefined;
  const asNumber = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };
  if ('value' in first) return asNumber(first.value);
  const numbers = Object.values(first).map(asNumber).filter((n): n is number => n !== undefined);
  return numbers.length === 1 ? numbers[0] : undefined;
};

const SECRET = /\b(?:postgres(?:ql)?|mysql|bigquery):\/\/|password\s*=|private_key|BEGIN [A-Z ]*PRIVATE KEY|service_account/i;

/** Whether a query carries what looks like a connection string or a key (never saved). */
export const looksSecret = (text: string): boolean => SECRET.test(text);

export type ScopeChange = { readonly added: readonly string[]; readonly removed: readonly string[] };

/** Tickets that came or went since the definition was accepted. */
export const scopeChange = (scope: readonly string[] | undefined, keys: readonly string[]): ScopeChange | undefined => {
  if (!scope) return undefined;
  const was = new Set(scope);
  const now = new Set(keys);
  const added = keys.filter((k) => !was.has(k));
  const removed = scope.filter((k) => !now.has(k));
  return added.length || removed.length ? { added, removed } : undefined;
};

export type KeptPoint = { readonly at: number; readonly value?: number };

export type BeforeSince = {
  readonly latest?: number;
  readonly before?: number;
  readonly since?: number;
  readonly beforeCount: number;
  readonly sinceCount: number;
};

const mean = (values: readonly number[]): number | undefined => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined);

/** The kept numbers before and since the ship date (averages), and the latest. Before falls back to the baseline. */
export const beforeSince = (points: readonly KeptPoint[], shippedAt: number | undefined, baseline: number | undefined): BeforeSince => {
  const kept = points.filter((p): p is { at: number; value: number } => typeof p.value === 'number' && Number.isFinite(p.value)).sort((a, b) => a.at - b.at);
  const latest = kept.at(-1)?.value;
  if (shippedAt === undefined) return { ...(latest !== undefined ? { latest } : {}), ...(baseline !== undefined ? { before: baseline } : {}), beforeCount: 0, sinceCount: 0 };
  const beforeValues = kept.filter((p) => p.at < shippedAt).map((p) => p.value);
  const sinceValues = kept.filter((p) => p.at >= shippedAt).map((p) => p.value);
  const before = mean(beforeValues) ?? baseline;
  const since = mean(sinceValues);
  return { ...(latest !== undefined ? { latest } : {}), ...(before !== undefined ? { before } : {}), ...(since !== undefined ? { since } : {}), beforeCount: beforeValues.length, sinceCount: sinceValues.length };
};

export const SUCCESS_VERDICTS = ['met', 'better', 'flat', 'worse', 'unknown'] as const;
export type SuccessVerdict = (typeof SUCCESS_VERDICTS)[number];

export const VERDICT_WORDS: Readonly<Record<SuccessVerdict, string>> = { met: 'Target met', better: 'Improving', flat: 'No change', worse: 'Worse', unknown: 'No numbers yet' };

/** Where a number stands against its baseline and target, in the metric's direction (within 1% of the baseline is flat). */
export const verdictOf = (value: number | undefined, metric: Pick<SuccessMetric, 'direction' | 'target'> & { readonly baseline?: number }): SuccessVerdict => {
  if (value === undefined) return 'unknown';
  const sign = metric.direction === 'up' ? 1 : -1;
  if ((value - metric.target) * sign >= 0) return 'met';
  if (metric.baseline === undefined) return 'unknown';
  const change = (value - metric.baseline) * sign;
  const room = Math.max(Math.abs(metric.baseline) * 0.01, Number.EPSILON);
  if (Math.abs(change) <= room) return 'flat';
  return change > 0 ? 'better' : 'worse';
};

export const formatSuccessNumber = (value: number | undefined, unit: SuccessUnit): string => {
  if (value === undefined) return '—';
  const n = Math.abs(value) >= 100 ? Math.round(value).toLocaleString('en-US') : Number(value.toFixed(2)).toLocaleString('en-US');
  if (unit === 'percent') return `${n}%`;
  if (unit === 'ms') return `${n} ms`;
  if (unit.startsWith('currency:')) return `${n} ${unit.slice('currency:'.length)}`;
  return n;
};
