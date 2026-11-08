/**
 * ~/.beluga/stats.json: your stats (shared/stats.ts), plus what the counter needs to count only
 * what's new: each workspace's tokens when last seen, and what was already backfilled.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { STAT_KEYS, type StatsSnapshot, dayStart } from '../../shared/stats.js';
import { belugaHome } from '../home.js';

const Counts = z.object(Object.fromEntries(STAT_KEYS.map((k) => [k, z.number().min(0).optional()])) as Record<(typeof STAT_KEYS)[number], z.ZodOptional<z.ZodNumber>>);
const Day = z.record(z.string(), z.record(z.string(), Counts));
const Pr = z.object({ project: z.string(), agent: z.string(), number: z.number().int(), title: z.string().optional(), opened: z.number(), merged: z.number().optional(), added: z.number().min(0), removed: z.number().min(0) });
const PlanWindowSchema = z.object({ runtime: z.string(), kind: z.enum(['session', 'week']), resetsAt: z.number(), peak: z.number().min(0).max(100), open: z.literal(true).optional() });
/** A workspace as last counted: its tokens and cost then, and whether it was archived. */
const Seen = z.object({ t: z.number().min(0), c: z.number().min(0), a: z.literal(1).optional() });

export const StatsFileSchema = z.object({
  v: z.literal(1),
  /** When counting began on this Mac: history from before is backfilled, after is counted live. */
  startedAt: z.number(),
  days: z.record(z.string(), Day).default({}),
  prs: z.record(z.string(), Pr).default({}),
  hours: z
    .array(z.number().min(0))
    .length(168)
    .default(() => Array.from({ length: 168 }, () => 0)),
  seen: z.record(z.string(), Seen).default({}),
  /** Chat histories already read for prompts and agent time (once). */
  history: z.boolean().default(false),
  /** When each project's pull requests were last asked of GitHub. */
  prsAt: z.record(z.string(), z.number()).default({}),
  /** Plan windows as they went (oldest first, the open ones too). */
  plan: z.array(PlanWindowSchema).default([]),
});
export type StatsFile = z.infer<typeof StatsFileSchema>;
export type Seen = z.infer<typeof Seen>;

export const statsPath = (): string => path.join(belugaHome(), 'stats.json');

export const emptyStats = (now: number): StatsFile => ({ v: 1, startedAt: now, days: {}, prs: {}, hours: Array.from({ length: 168 }, () => 0), seen: {}, history: false, prsAt: {}, plan: [] });

/** The file, or a new one starting now when there's none (or it can't be read). */
export function loadStats(file: string, now: number): StatsFile {
  try {
    const parsed = StatsFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : emptyStats(now);
  } catch {
    return emptyStats(now);
  }
}

export function saveStats(data: StatsFile, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

/** What the Usage tab gets: the stats, without the counter's bookkeeping. */
export function snapshotOf(data: StatsFile, backfilling: boolean): StatsSnapshot {
  const firstDay = Object.keys(data.days).sort()[0];
  const firstPr = Math.min(Infinity, ...Object.values(data.prs).map((p) => p.opened));
  const since = Math.min(firstDay ? dayStart(firstDay) : Infinity, firstPr);
  return { days: data.days, prs: data.prs, hours: data.hours, plan: data.plan, since: Number.isFinite(since) ? since : 0, ...(backfilling ? { backfilling } : {}) };
}
