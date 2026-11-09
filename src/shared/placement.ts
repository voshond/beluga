/**
 * Best Available (BLG-789): which of your computers a task runs on, from what each has free, and
 * one line saying why. Only a computer that can take it is weighed: online, on this app's version,
 * with the project or able to clone it, and the task's runtime signed in with room in its plan.
 * Among those, free memory, CPU load per core, free disk, agents already running and the link's
 * round trip each count; the line names what decided it. Pure and browser-safe.
 */

export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  /** On another version: it can't take new work. */
  readonly readOnly?: boolean;
  /** It has the project already. */
  readonly hasProject: boolean;
  /** It can clone the project (its git or gh can reach it). */
  readonly canClone: boolean;
  /** The task's runtime there: ready, signed out, not set up, or at its plan's limit. */
  readonly runtime: 'ready' | 'signed_out' | 'missing' | 'limited';
  readonly freeMemGB: number;
  readonly loadPerCore: number;
  readonly freeDiskGB?: number;
  readonly agentsRunning: number;
  readonly rttMs?: number;
}

export type Factor = 'memory' | 'load' | 'disk' | 'agents' | 'link';

export interface Placed {
  /** The computer picked (none: none can take it). */
  readonly id?: string;
  readonly name?: string;
  /** One line: why this one, or why none. */
  readonly why: string;
  /** What decided it (none: nothing to weigh, or none could). */
  readonly factor?: Factor;
  /** Each computer that could take it, best first, with its score (0–1). */
  readonly ranked: ReadonlyArray<{ readonly id: string; readonly score: number }>;
}

/** How much each counts. */
export const WEIGHTS: Readonly<Record<Factor, number>> = { memory: 0.3, load: 0.3, agents: 0.2, disk: 0.1, link: 0.1 };
/** Less free disk than this and a clone or a build may not fit: it isn't picked. */
export const MIN_DISK_GB = 5;
/** A round trip this long or longer counts as the slowest. */
const SLOW_RTT_MS = 300;

/** Why a computer can't take it, in words (none: it can). */
export function cantTake(c: Candidate): string | undefined {
  if (!c.online) return 'offline';
  if (c.readOnly) return 'on another version';
  if (c.runtime === 'signed_out') return 'not signed in';
  if (c.runtime === 'missing') return 'not set up';
  if (c.runtime === 'limited') return 'at its plan’s limit';
  if (!c.hasProject && !c.canClone) return 'can’t get the project';
  if (c.freeDiskGB !== undefined && c.freeDiskGB < MIN_DISK_GB) return 'nearly out of disk';
  return undefined;
}

/** Each factor of a computer among the others, 0 (worst) to 1 (best). */
function factorsOf(c: Candidate, all: readonly Candidate[]): Record<Factor, number> {
  const most = (pick: (x: Candidate) => number | undefined): number => Math.max(0, ...all.map((x) => pick(x) ?? 0));
  const mem = most((x) => x.freeMemGB);
  const disk = most((x) => x.freeDiskGB);
  return {
    memory: mem > 0 ? c.freeMemGB / mem : 1,
    load: 1 - Math.min(1, Math.max(0, c.loadPerCore)),
    agents: 1 / (1 + Math.max(0, c.agentsRunning)),
    disk: c.freeDiskGB === undefined ? 0.5 : disk > 0 ? c.freeDiskGB / disk : 1,
    link: c.rttMs === undefined ? 0.5 : 1 - Math.min(1, c.rttMs / SLOW_RTT_MS),
  };
}

const scoreOf = (f: Record<Factor, number>): number => (Object.keys(WEIGHTS) as Factor[]).reduce((sum, k) => sum + WEIGHTS[k] * f[k], 0);

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** What decided it, in words: "the most free memory (25 GB)". */
function factorWords(f: Factor, c: Candidate): string {
  switch (f) {
    case 'memory':
      return `the most free memory (${Math.round(c.freeMemGB)} GB)`;
    case 'load':
      return `the least busy CPU (${Math.round(c.loadPerCore * 100)}%)`;
    case 'agents':
      return c.agentsRunning ? `the fewest tasks running (${c.agentsRunning})` : 'no tasks running';
    case 'disk':
      return `the most free disk (${Math.round(c.freeDiskGB ?? 0)} GB)`;
    case 'link':
      return `the quickest link (${c.rttMs} ms)`;
  }
}

/** Pick the computer with the most room for a task, and say why. */
export function pickComputer(candidates: readonly Candidate[]): Placed {
  const able = candidates.filter((c) => !cantTake(c));
  if (!able.length) {
    if (!candidates.length) return { why: 'You have no computers paired.', ranked: [] };
    const reasons = candidates.map((c) => `${c.name} is ${cantTake(c)}`);
    return { why: `None of your computers can take it: ${reasons.join(', ')}.`, ranked: [] };
  }
  if (able.length === 1) {
    const only = able[0]!;
    return { id: only.id, name: only.name, why: candidates.length === 1 ? `${only.name} is your only computer.` : `${only.name} is the only one that can take it.`, ranked: [{ id: only.id, score: 1 }] };
  }
  const scored = able
    .map((c) => {
      const f = factorsOf(c, able);
      return { c, f, score: round(scoreOf(f)) };
    })
    // Best first; a tie goes to the one that has the project, then by name, so it's the same each time.
    .sort((a, b) => b.score - a.score || Number(b.c.hasProject) - Number(a.c.hasProject) || a.c.name.localeCompare(b.c.name));
  const [first, second] = [scored[0]!, scored[1]!];
  const ranked = scored.map((s) => ({ id: s.c.id, score: s.score }));
  if (first.score === second.score) {
    const why = first.c.hasProject !== second.c.hasProject ? `${first.c.name} and ${second.c.name} have as much room; ${first.c.name} has the project already.` : `${first.c.name} and ${second.c.name} have as much room; ${first.c.name} it is.`;
    return { id: first.c.id, name: first.c.name, why, ranked };
  }
  // What put it ahead of the next best: the factor with the biggest weighted lead.
  const lead = (Object.keys(WEIGHTS) as Factor[]).map((k) => [k, WEIGHTS[k] * (first.f[k] - second.f[k])] as const).sort((a, b) => b[1] - a[1])[0]!;
  return { id: first.c.id, name: first.c.name, why: `${first.c.name} has ${factorWords(lead[0], first.c)}.`, factor: lead[0], ranked };
}
