import { type Candidate, pickComputer } from '../shared/placement.js';
import { githubSlug, sameRepo } from '../shared/repo-key.js';
import type { MachineView } from './machines.js';

/**
 * Where new work runs (BLG-780, Settings › Your Computers › Run New Work On): this computer, one of
 * yours by name, or Best Available: the least busy of your computers that is online, on this app's
 * version and has Claude signed in, when it's less busy than this one. A computer that isn't
 * ready means this one, said in words, so new work always has somewhere to go.
 */

export type Placement = { readonly where: 'here'; readonly why: string } | { readonly where: 'computer'; readonly id: string; readonly name: string; readonly why: string };

/** A computer that can take new work now. */
export const ready = (m: MachineView): boolean => m.status === 'online' && !m.readOnly && Boolean(m.info?.runtimes.some((r) => r.id === 'claude' && r.state === 'ready'));

/** How busy a computer is: its load per core, and a little for each agent it runs. */
const busyness = (m: MachineView): number => (m.info?.loadPerCore ?? 1) + (m.info?.agentsRunning ?? 0) * 0.1;

export function placeNewWork(runOn: string, machines: readonly MachineView[], here: { readonly name: string; readonly loadPerCore?: number }, opts: { readonly runtime?: string; readonly origin?: string } = {}): Placement {
  if (runOn === 'here') return { where: 'here', why: `New work runs on ${here.name}.` };
  if (runOn === 'best') {
    // Best Available (BLG-789): the computer with the most room, and what decided it.
    const picked = pickComputer(machines.map((m) => candidateOf(m, opts.runtime, opts.origin)));
    const best = picked.id ? machines.find((m) => m.id === picked.id) : undefined;
    if (!best) return { where: 'here', why: `None of your computers is ready, so new work runs on ${here.name}.` };
    if (here.loadPerCore !== undefined && here.loadPerCore <= busyness(best)) return { where: 'here', why: `${here.name} is the least busy right now.` };
    return { where: 'computer', id: best.id, name: best.name, why: picked.why };
  }
  const chosen = machines.find((m) => m.id === runOn);
  if (!chosen) return { where: 'here', why: `That computer is gone from your devices, so new work runs on ${here.name}.` };
  if (!ready(chosen)) return { where: 'here', why: `${chosen.name} isn’t ready (${chosen.status !== 'online' ? 'offline' : chosen.readOnly ? 'on another version' : 'Claude isn’t signed in there'}), so new work runs on ${here.name} for now.` };
  return { where: 'computer', id: chosen.id, name: chosen.name, why: `New work runs on ${chosen.name}.` };
}

/**
 * A computer as Best Available weighs it (src/shared/placement.ts) for a task on `runtime` in the
 * project at `origin` (none: any project).
 */
export function candidateOf(m: MachineView, runtime = 'claude', origin?: string, now = Date.now()): Candidate {
  const i = m.info;
  const r = i?.runtimes.find((x) => x.id === runtime);
  const limited = [r?.usage?.fiveHour, r?.usage?.week].some((u) => u && u.pct >= 100 && (u.resetsAt === undefined || u.resetsAt > now));
  const hasProject = !origin || Boolean(i?.projects.some((p) => p.origin && sameRepo(p.origin, origin)));
  // GitHub over https needs its sign-in there; anything else, its git is trusted to reach it (a clone says if not).
  const canClone = !origin || !(githubSlug(origin) && /^https?:/.test(origin) && i?.gh !== 'signed_in');
  return {
    id: m.id,
    name: m.name,
    online: m.status === 'online',
    ...(m.readOnly ? { readOnly: true } : {}),
    hasProject,
    canClone,
    runtime: !r || r.state === 'missing' ? 'missing' : r.state === 'signed_out' ? 'signed_out' : limited ? 'limited' : 'ready',
    freeMemGB: i?.memory.freeGB ?? 0,
    loadPerCore: i?.loadPerCore ?? 1,
    ...(i?.disk ? { freeDiskGB: i.disk.freeGB } : {}),
    agentsRunning: i?.agentsRunning ?? 0,
    ...(m.rttMs !== undefined ? { rttMs: m.rttMs } : {}),
  };
}
