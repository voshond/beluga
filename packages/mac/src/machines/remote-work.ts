// Relative, not @beluga: the root's tests and typecheck read this file too.
import type { DomainState } from '../../../../src/core/store.js';
import { planTitle } from '../../../../src/core/plans/model.js';
import type { MachineView } from '../../../../src/machines/machines.js';

/**
 * Every computer's work in this app's lists (BLG-785), as plain data: what each computer has
 * (its projects with their worktrees and chats, plans, sentinels, tasks, dashboards), kept as last
 * seen so an offline computer's items stay, greyed, with when it was seen. Matched to this Mac's
 * projects by name. No DOM here (tests/mac-remote-work.test.ts).
 */

export interface RemoteWorkspace {
  readonly id: string;
  readonly name: string;
  readonly kind: 'main' | 'worktree' | 'chat';
}

export interface RemoteSnapshot {
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string; readonly workspaces: readonly RemoteWorkspace[] }>;
  readonly plans: ReadonlyArray<{ readonly id: string; readonly title: string; readonly projectId: string; readonly status: string }>;
  readonly sentinels: ReadonlyArray<{ readonly id: string; readonly name: string; readonly projectId?: string; readonly paused?: boolean }>;
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly key: string; readonly title: string; readonly status: string; readonly projectId: string }>;
  readonly dashboards: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/** One computer's work: live while its screen is open, else as last seen. */
export interface RemoteSource {
  readonly machine: MachineView;
  readonly snapshot?: RemoteSnapshot;
  /** Its screen is open now (else this is what it had when last seen). */
  readonly live: boolean;
  /** When the snapshot was taken. */
  readonly at?: number;
}

const LIMIT = 200;

/** What the lists need of a computer's state (nothing else is kept). */
export function snapshotOf(state: Pick<DomainState, 'projects' | 'plans' | 'sentinel' | 'board'>): RemoteSnapshot {
  return {
    projects: state.projects.slice(0, LIMIT).map((p) => ({ id: p.id, name: p.name, workspaces: p.workspaces.filter((w) => !w.archived).slice(0, LIMIT).map((w) => ({ id: w.id, name: w.name, kind: w.kind })) })),
    plans: state.plans.plans.slice(0, LIMIT).map((p) => ({ id: p.id, title: planTitle(p), projectId: p.projectId, status: p.status })),
    sentinels: state.sentinel.items.slice(0, LIMIT).map((x) => ({ id: x.id, name: x.name, ...(x.projectId ? { projectId: x.projectId } : {}), ...(x.paused ? { paused: true } : {}) })),
    tasks: state.board.enabled ? state.board.issues.slice(0, LIMIT).map((i) => ({ id: i.id, key: i.key, title: i.title, status: i.status, projectId: i.projectId })) : [],
    dashboards: (state.sentinel.dashboards ?? []).slice(0, 50).map((d) => ({ id: d.id, name: d.name })),
  };
}

/** A row from a computer: the computer, and whether it's offline (greyed, with when it was seen). */
export interface Tagged<T> {
  readonly machine: MachineView;
  readonly item: T;
  readonly offline: boolean;
  readonly at?: number;
}

const tag = <T,>(src: RemoteSource, item: T): Tagged<T> => ({ machine: src.machine, item, offline: !src.live || src.machine.status !== 'online', ...(src.at !== undefined ? { at: src.at } : {}) });

/** A computer's worktrees and chats in the project named `name` (its main folder's own conversation is the project's). */
export function remoteWorkIn(name: string, sources: readonly RemoteSource[]): Array<Tagged<RemoteWorkspace & { readonly projectId: string }>> {
  return sources.flatMap((src) =>
    (src.snapshot?.projects ?? [])
      .filter((p) => p.name === name)
      .flatMap((p) => p.workspaces.filter((w) => w.kind !== 'main').map((w) => tag(src, { ...w, projectId: p.id }))),
  );
}

/** A computer's projects this Mac doesn't have (by name), with their worktrees and chats. */
export function remoteOnlyProjects(localNames: ReadonlySet<string>, sources: readonly RemoteSource[]): Array<Tagged<RemoteSnapshot['projects'][number]>> {
  return sources.flatMap((src) => (src.snapshot?.projects ?? []).filter((p) => !localNames.has(p.name)).map((p) => tag(src, p)));
}

/** The project's name on its computer (for a plan's or a task's row). */
const projectName = (src: RemoteSource, id: string | undefined): string | undefined => src.snapshot?.projects.find((p) => p.id === id)?.name;

export const remotePlans = (sources: readonly RemoteSource[]) => sources.flatMap((src) => (src.snapshot?.plans ?? []).map((p) => tag(src, { ...p, project: projectName(src, p.projectId) })));
export const remoteSentinels = (sources: readonly RemoteSource[]) => sources.flatMap((src) => (src.snapshot?.sentinels ?? []).map((x) => tag(src, { ...x, project: projectName(src, x.projectId) })));
export const remoteTasks = (sources: readonly RemoteSource[]) => sources.flatMap((src) => (src.snapshot?.tasks ?? []).map((t) => tag(src, { ...t, project: projectName(src, t.projectId) })));
export const remoteDashboards = (sources: readonly RemoteSource[]) => sources.flatMap((src) => (src.snapshot?.dashboards ?? []).map((d) => tag(src, d)));

/** "build-box", or "build-box · offline, seen 5 min ago". */
export function whereLine(t: Pick<Tagged<unknown>, 'machine' | 'offline' | 'at'>, now = Date.now()): string {
  if (!t.offline) return t.machine.name;
  const seen = t.machine.lastSeen ?? t.at;
  return seen ? `${t.machine.name} · offline, seen ${ago(now - seen)} ago` : `${t.machine.name} · offline`;
}

const ago = (ms: number): string => {
  const min = Math.round(ms / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min` : min < 60 * 24 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
};

/** A computer's short name for a tag: its first word or two, at most 14 characters. */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/);
  const two = words.slice(0, 2).join(' ');
  return (two.length <= 14 ? two : words[0]!).slice(0, 14);
}

/**
 * A demo computer is this daemon pretending (src/machines/demo.ts): only the work it says it runs
 * is its own, so nothing of this Mac's shows twice.
 */
export function onlyItsWork(snapshot: RemoteSnapshot, work: ReadonlyArray<{ readonly channel: string }> | undefined): RemoteSnapshot {
  const ids = new Set((work ?? []).map((w) => w.channel.replace(/^ws:/, '')));
  const projects = snapshot.projects.map((p) => ({ ...p, workspaces: p.workspaces.filter((w) => ids.has(w.id)) })).filter((p) => p.workspaces.length);
  return { projects, plans: [], sentinels: [], tasks: [], dashboards: [] };
}
