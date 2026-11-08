/**
 * Your stats (the Usage tab, BLG-755): what you and your agents did, day by day, per project and
 * per agent. The daemon keeps them in ~/.beluga/stats.json (core/stats/), counted as things happen
 * and backfilled once from what Beluga already knew. This file is the shape and the sums both
 * sides share: browser-safe, no imports at runtime.
 */

/** What is counted. Every one is a plain sum, so a day, a project or an agent adds up the same way. */
export interface StatCounts {
  /** Messages you sent to your agent. */
  readonly prompts: number;
  /** Characters in them. */
  readonly chars: number;
  /** Characters you pasted into the composer. */
  readonly pasted: number;
  /** How long you dictated (ms). */
  readonly dictationMs: number;
  /** How long your agent worked on your runs (ms). */
  readonly agentMs: number;
  /** Runs it did. */
  readonly runs: number;
  /** Worktrees made. */
  readonly worktrees: number;
  /** Chats started. */
  readonly chats: number;
  /** Worktrees archived. */
  readonly archived: number;
  readonly tokens: number;
  /** Estimated cost (USD). */
  readonly cost: number;
}

export type StatKey = keyof StatCounts;
export const STAT_KEYS: readonly StatKey[] = ['prompts', 'chars', 'pasted', 'dictationMs', 'agentMs', 'runs', 'worktrees', 'chats', 'archived', 'tokens', 'cost'];
export const ZERO: StatCounts = Object.freeze(Object.fromEntries(STAT_KEYS.map((k) => [k, 0])) as unknown as StatCounts);

/** Runtimes ("claude", "codex", "local", …); "" when nobody's agent is involved (pasting, dictation outside a run). */
export type AgentKey = string;
/** A project's root folder; "" for chats outside any project. */
export type ProjectKey = string;

/** One day: project → agent → what was counted (only the counts that aren't 0). */
export type StatDay = Readonly<Record<ProjectKey, Readonly<Record<AgentKey, Partial<StatCounts>>>>>;

/** A pull request opened from one of Beluga's worktrees (learned from GitHub, so it backfills). */
export interface PrStat {
  readonly project: ProjectKey;
  readonly agent: AgentKey;
  readonly number: number;
  readonly title?: string;
  readonly opened: number;
  readonly merged?: number;
  readonly added: number;
  readonly removed: number;
}

/** Which plan window: the 5-hour session, or the week. */
export type PlanKind = 'session' | 'week';

/**
 * One plan window of a provider (Claude's 5-hour session, its week): the most of it you used before
 * it reset. Learned from the plan usage Beluga already reads, so only from when counting began.
 */
export interface PlanWindow {
  readonly runtime: string;
  readonly kind: PlanKind;
  /** When it reset (epoch ms). */
  readonly resetsAt: number;
  /** The most of it used (0–100). */
  readonly peak: number;
  /** Still going: it hasn't reset yet. */
  readonly open?: true;
}

/** How long each kind lasts. */
export const PLAN_SPAN: Record<PlanKind, number> = { session: 5 * 3_600_000, week: 7 * 86_400_000 };

/** What the Usage tab asks the daemon for. */
export interface StatsSnapshot {
  /** "2026-10-18" → that day. */
  readonly days: Readonly<Record<string, StatDay>>;
  /** "root#123" → the PR. */
  readonly prs: Readonly<Record<string, PrStat>>;
  /** Prompts by weekday (0 Sunday) × hour: 168 counts, when you work. */
  readonly hours: readonly number[];
  /** The earliest thing counted (epoch ms; 0: nothing yet). */
  readonly since: number;
  /** Plan windows, oldest first (the open ones last). */
  readonly plan?: readonly PlanWindow[];
  /** The GitHub CLI isn't installed or signed in on this Mac: pull requests (and their lines) aren't counted. */
  readonly noGitHub?: true;
  /** Still reading what came before (the first start): numbers will grow. */
  readonly backfilling?: boolean;
}

export const EMPTY_STATS: StatsSnapshot = { days: {}, prs: {}, hours: Array.from({ length: 168 }, () => 0), since: 0 };

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local day a moment falls on, as "2026-10-18". */
export function statDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a "2026-10-18". */
export const dayStart = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!).getTime();
};

/** `a` plus `b`, keeping only counts that aren't 0. */
export function addCounts(a: Partial<StatCounts> | undefined, b: Partial<StatCounts>): Partial<StatCounts> {
  const out: Record<string, number> = { ...a };
  for (const k of STAT_KEYS) {
    const v = b[k];
    if (!v) continue;
    out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

/** A copy of `day` with `add` counted on project × agent. */
export function addToDay(day: StatDay | undefined, project: ProjectKey, agent: AgentKey, add: Partial<StatCounts>): StatDay {
  const p = day?.[project];
  return { ...day, [project]: { ...p, [agent]: addCounts(p?.[agent], add) } };
}

// ------------------------------------------------------------------ reading

/** Which days a view covers. */
export type StatRange = 'week' | 'month' | 'year' | 'all';
export const RANGE_DAYS: Record<Exclude<StatRange, 'all'>, number> = { week: 7, month: 30, year: 365 };

/** The first day key in `range` up to `now` (inclusive), or "" for all time. */
export function rangeStart(range: StatRange, now: number): string {
  if (range === 'all') return '';
  const t = new Date(now);
  return statDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - (RANGE_DAYS[range] - 1)).getTime());
}

/** The same length of time just before `range` (for "↑ 20%"): [from, to) as day keys; undefined for all time. */
export function previousRange(range: StatRange, now: number): { from: string; to: string } | undefined {
  if (range === 'all') return undefined;
  const t = new Date(now);
  const n = RANGE_DAYS[range];
  return { from: statDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - (2 * n - 1)).getTime()), to: rangeStart(range, now) };
}

/** Everything a view shows, summed: counts plus pull requests. */
export interface Totals extends StatCounts {
  readonly prsOpened: number;
  readonly prsMerged: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}
export type TotalKey = keyof Totals;

const ZERO_TOTALS: Totals = { ...ZERO, prsOpened: 0, prsMerged: 0, linesAdded: 0, linesRemoved: 0 };

const inside = (key: string, from: string, to?: string): boolean => key >= from && (to === undefined || key < to);

/** What `pick` says each group (a project or an agent) did between `from` and `to` (day keys; `to` exclusive). */
export function totalsBy(stats: StatsSnapshot, by: 'project' | 'agent' | 'all', from: string, to?: string): Map<string, Totals> {
  const out = new Map<string, Record<TotalKey, number>>();
  const bucket = (key: string): Record<TotalKey, number> => {
    let t = out.get(key);
    if (!t) out.set(key, (t = { ...ZERO_TOTALS }));
    return t;
  };
  const group = (project: string, agent: string): string => (by === 'project' ? project : by === 'agent' ? agent : '');
  for (const [key, day] of Object.entries(stats.days)) {
    if (!inside(key, from, to)) continue;
    for (const [project, agents] of Object.entries(day)) {
      for (const [agent, counts] of Object.entries(agents)) {
        const t = bucket(group(project, agent));
        for (const k of STAT_KEYS) t[k] += counts[k] ?? 0;
      }
    }
  }
  for (const pr of Object.values(stats.prs)) {
    const t = () => bucket(group(pr.project, pr.agent));
    if (inside(statDay(pr.opened), from, to)) t().prsOpened += 1;
    if (pr.merged !== undefined && inside(statDay(pr.merged), from, to)) {
      const b = t();
      b.prsMerged += 1;
      b.linesAdded += pr.added;
      b.linesRemoved += pr.removed;
    }
  }
  return out as Map<string, Totals>;
}

/** Everything between `from` and `to`, in one. */
export const totalsOf = (stats: StatsSnapshot, from: string, to?: string): Totals => totalsBy(stats, 'all', from, to).get('') ?? ZERO_TOTALS;

/** One number of a day: a count, or a pull-request figure. */
export function dayValue(stats: StatsSnapshot, key: string, metric: TotalKey): number {
  if (metric === 'prsOpened' || metric === 'prsMerged' || metric === 'linesAdded' || metric === 'linesRemoved') return totalsOf(stats, key, nextDay(key))[metric];
  let n = 0;
  for (const agents of Object.values(stats.days[key] ?? {})) for (const c of Object.values(agents)) n += c[metric] ?? 0;
  return n;
}

/** Per day of the last `count` days up to `now`, oldest first: `metric` summed. PR figures are done in one pass. */
export function dailySeries(stats: StatsSnapshot, metric: TotalKey, now: number, count: number): Array<{ key: string; value: number }> {
  const t = new Date(now);
  const keys = Array.from({ length: count }, (_, i) => statDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - (count - 1 - i)).getTime()));
  const pr: Record<string, number> = {};
  if (metric === 'prsOpened' || metric === 'prsMerged' || metric === 'linesAdded' || metric === 'linesRemoved') {
    for (const p of Object.values(stats.prs)) {
      if (metric === 'prsOpened') pr[statDay(p.opened)] = (pr[statDay(p.opened)] ?? 0) + 1;
      else if (p.merged !== undefined) pr[statDay(p.merged)] = (pr[statDay(p.merged)] ?? 0) + (metric === 'prsMerged' ? 1 : metric === 'linesAdded' ? p.added : p.removed);
    }
    return keys.map((key) => ({ key, value: pr[key] ?? 0 }));
  }
  return keys.map((key) => ({ key, value: dayValue(stats, key, metric) }));
}

/** The day `by` days after `key` (before, when negative). */
export function shiftDay(key: string, by: number): string {
  const d = new Date(dayStart(key));
  return statDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + by).getTime());
}
const nextDay = (key: string): string => shiftDay(key, 1);

/** Days in a row with something done, ending today (or yesterday: today isn't over), and the longest run ever. */
export function streaks(stats: StatsSnapshot, now: number): { current: number; longest: number } {
  const active = new Set(
    Object.entries(stats.days)
      .filter(([, d]) => Object.values(d).some((a) => Object.values(a).some((c) => (c.prompts ?? 0) + (c.runs ?? 0) > 0)))
      .map(([k]) => k),
  );
  const keys = [...active].sort();
  let longest = 0;
  let run = 0;
  let prev = '';
  for (const k of keys) {
    run = prev && nextDay(prev) === k ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = k;
  }
  const today = statDay(now);
  let day = active.has(today) ? today : shiftDay(today, -1);
  let current = 0;
  while (active.has(day)) {
    current += 1;
    day = shiftDay(day, -1);
  }
  return { current, longest };
}

// ------------------------------------------------------------------ plan windows

export interface PlanSummary {
  /** Windows that ended in the stretch. */
  readonly windows: number;
  /** Their average peak (0–100). */
  readonly used: number;
  /** How many ran out (100%). */
  readonly maxed: number;
  /** The time those windows had and you didn't use (ms): (100 − peak)% of each. */
  readonly leftMs: number;
}

/** A provider's closed windows of one kind since `from` (epoch ms), summed up. */
export function planSummary(windows: readonly PlanWindow[], runtime: string, kind: PlanKind, from: number): PlanSummary {
  const list = windows.filter((w) => !w.open && w.runtime === runtime && w.kind === kind && w.resetsAt >= from);
  const used = list.length ? list.reduce((n, w) => n + w.peak, 0) / list.length : 0;
  return { windows: list.length, used, maxed: list.filter((w) => w.peak >= 99.5).length, leftMs: list.reduce((n, w) => n + ((100 - w.peak) / 100) * PLAN_SPAN[kind], 0) };
}
