import { sameRepo } from '../shared/repo-key.js';
import type { MachineView } from './machines.js';
import { placeNewWork } from './placement.js';

/**
 * Where new work goes (BLG-788): Runs on's pick (or Run New Work On) made concrete. This Mac, or
 * one of your computers that can take it now, and whether that computer has the project already
 * (by its git origin, else by name) or has to get it ready first. A pick that can't take it any more
 * (offline since, signed out) runs here, said in words. Pure and browser-safe.
 */

export type Route =
  | { readonly where: 'here'; readonly why?: string }
  | {
      readonly where: 'computer';
      readonly machine: MachineView;
      /** The project's name there, when it has it (none: get it ready first). */
      readonly project?: string;
      readonly why?: string;
    };

export interface RouteInput {
  /** `here`, `best`, or a computer's id. */
  readonly runsOn: string;
  readonly machines: readonly MachineView[];
  readonly hereName: string;
  /** The task's runtime (claude, codex…). */
  readonly runtime: string;
  /** The project the work is in (none: work outside a project, a sentinel on the computer itself). */
  readonly project?: { readonly name: string; readonly origin?: string };
}

/** The project on a computer: the one with the same origin, else the same name. */
export function projectThere(m: MachineView, project: { readonly name: string; readonly origin?: string }): string | undefined {
  const there = m.info?.projects ?? [];
  const byOrigin = project.origin ? there.find((p) => p.origin && sameRepo(p.origin, project.origin!)) : undefined;
  return (byOrigin ?? there.find((p) => p.name === project.name))?.name;
}

export function routeWork(input: RouteInput): Route {
  const { runsOn, machines, hereName, runtime, project } = input;
  if (runsOn === 'here') return { where: 'here' };
  const placed = placeNewWork(runsOn, machines, { name: hereName }, { runtime, ...(project?.origin ? { origin: project.origin } : {}) });
  if (placed.where === 'here') return { where: 'here', why: placed.why };
  const machine = machines.find((m) => m.id === placed.id)!;
  // A computer picked by name: it must still have this runtime signed in (Best Available already weighed it).
  const r = machine.info?.runtimes.find((x) => x.id === runtime);
  if (runsOn !== 'best' && r?.state !== 'ready') return { where: 'here', why: `${machine.name} can’t run it now (${runtime} isn’t signed in there), so it runs on ${hereName}.` };
  const name = project ? projectThere(machine, project) : undefined;
  return { where: 'computer', machine, ...(name ? { project: name } : {}), ...(runsOn === 'best' ? { why: placed.why } : {}) };
}
