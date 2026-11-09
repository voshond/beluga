// Relative, not @beluga: the root's tests and typecheck read this file too.
import type { MachineView } from '../../../../src/machines/machines.js';
import { placeNewWork } from '../../../../src/machines/placement.js';
import { statusLine, whyNot } from '../../../../src/machines/words.js';

// The words themselves are the engine's (the phone's Runs on sheet says the same, BLG-810).
export { runtimeWords, statusLine, whyNot } from '../../../../src/machines/words.js';

/**
 * Runs on (BLG-786): where new work goes, picked beside the mode and model wherever work is made
 * (the chat's box, a project's home, New Plan, New Sentinel). This Mac, one of your computers, or
 * Best Available. A computer that can't take the work says why on its row and can't be picked.
 * Screens say computer, never machine, host or client. Pure, so it's tested without a window.
 */

/** `here`, `best`, or a computer's id: the same values as Settings' Run New Work On. */
export type RunsOn = string;

export const HERE = 'here';
export const BEST = 'best';

export interface RunsOnRow {
  readonly value: RunsOn;
  readonly label: string;
  /** One plain line: what it has free, or why it can't take the work. */
  readonly line: string;
  /** It can't take the work now (the line says why). */
  readonly disabled: boolean;
  /** The computer itself, for its mark (none: This Mac or Best Available). */
  readonly machine?: MachineView;
}

/** Best Available's line: what it does, and which computer it would pick now and why. */
export function bestLine(machines: readonly MachineView[], hereName: string, runtime = 'claude'): string {
  const p = placeNewWork(BEST, machines, { name: hereName }, { runtime });
  return `Picks the computer with the most room. ${p.why}`;
}

/** The menu's rows: This Mac, each computer, Best Available. */
export function runsOnRows(machines: readonly MachineView[], runtime: string, hereName: string, now = Date.now()): RunsOnRow[] {
  return [
    { value: HERE, label: hereName, line: 'The computer in front of you', disabled: false },
    ...machines.map((m) => {
      const why = whyNot(m, runtime, now);
      return { value: m.id, label: m.name, line: why ?? statusLine(m), disabled: Boolean(why), machine: m };
    }),
    { value: BEST, label: 'Best Available', line: bestLine(machines, hereName, runtime), disabled: false },
  ];
}

/** What the chip says after "Runs on": This Mac, the computer's name, or Best Available. */
export function runsOnName(value: RunsOn, machines: readonly MachineView[], hereName: string): string {
  if (value === BEST) return 'Best Available';
  if (value === HERE) return hereName;
  return machines.find((m) => m.id === value)?.name ?? hereName;
}

/**
 * Where a project's new work starts: the last pick there, else Settings' Run New Work On. A
 * computer that's gone from your devices is this Mac again.
 */
export function startingPick(remembered: RunsOn | undefined, runOn: RunsOn, machines: readonly MachineView[]): RunsOn {
  const pick = remembered ?? runOn;
  if (pick === HERE || pick === BEST) return pick;
  return machines.some((m) => m.id === pick) ? pick : HERE;
}

/** The last picks, by project (`mac`: work that isn't in a project), the newest kept. */
export const REMEMBERED_PICKS = 50;

export function rememberPick(picks: Readonly<Record<string, RunsOn>>, project: string, value: RunsOn): Record<string, RunsOn> {
  const { [project]: _old, ...rest } = picks;
  const entries = Object.entries(rest);
  const kept = entries.length >= REMEMBERED_PICKS ? entries.slice(entries.length - REMEMBERED_PICKS + 1) : entries;
  return { ...Object.fromEntries(kept), [project]: value };
}

/**
 * Why work for the computer Runs on names doesn't start (BLG-841; none: it can go): that computer
 * can't take it now (it's never made here instead), or a folder chat's folder is on this Mac.
 */
export function holdReason(route: { readonly where: 'here' } | { readonly where: 'computer'; readonly machine: Pick<MachineView, 'name'> }, picked: RunsOn, machines: readonly MachineView[], runtime: string, hereName: string, folder?: string, now = Date.now()): string | undefined {
  const named = machines.find((m) => m.id === picked);
  if (route.where === 'here' && named) return `${named.name} can’t take it now (${whyNot(named, runtime, now) ?? 'not ready'}). Nothing was started: pick another computer in Runs on, or wait for it.`;
  if (route.where === 'computer' && folder) return `That folder is on ${hereName}, so ${route.machine.name} can’t use it. Open ${route.machine.name}’s page to start a chat in one of its folders, or pick ${hereName} in Runs on.`;
  return undefined;
}
