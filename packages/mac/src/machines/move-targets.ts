import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { MachineView } from '@beluga/machines/machines.js';
import type { MovePlace } from '@beluga/machines/move-plan.js';
import { sameRepo } from '@beluga/shared/repo-key.js';
import { useBeluga } from '../lib/beluga.js';
import { thisComputer, upFirst } from '../lib/os-words.js';
import { clientOf, projectReadyOn } from './start-there.js';
import { useMachines } from './use-machines.js';

/**
 * Where Move To ▸ can send work from the page you're on (BLG-806, BLG-807): your other computers
 * that can take it now, and This Mac from a computer's page. Each knows its client and finds the
 * work's project there (by origin, else name), getting it ready on a computer that lacks it.
 */

export interface MoveTarget {
  readonly place: MovePlace;
  /** The computer (none: This Mac). */
  readonly machine?: MachineView;
}

export interface MoveTargets {
  /** No computer is paired: there's nowhere to move to. */
  readonly none: boolean;
  /** Where the work is now. */
  readonly from: MovePlace;
  /** That computer's client (the page's). */
  readonly fromClient: SocketClient;
  readonly targets: readonly MoveTarget[];
  readonly clientFor: (t: MoveTarget) => Promise<SocketClient>;
  /** The project's id there; `say` hears each step of getting it ready. */
  readonly projectOn: (t: MoveTarget, client: SocketClient, project: { readonly name: string; readonly origin?: string }, say: (words: string) => void) => Promise<string>;
}

/** A project on This Mac: the one with the same origin, else the same name. */
async function projectHere(home: SocketClient, project: { readonly name: string; readonly origin?: string }): Promise<string> {
  const mine = home.store.getState().projects.filter((p) => p.root && !p.error);
  if (project.origin) {
    for (const p of mine) {
      const origin = (await home.call('projects.origin', p.id).catch(() => null)) as string | null;
      if (origin && sameRepo(origin, project.origin)) return p.id;
    }
  }
  const named = mine.find((p) => p.name === project.name);
  if (named) return named.id;
  throw new Error(`${upFirst(thisComputer())} doesn’t have ${project.name}: add it, then move it again`);
}

export function useMoveTargets(): MoveTargets {
  const { home, client, machine, ui } = useBeluga();
  const machines = useMachines(home);
  const hereName = upFirst(thisComputer());
  const from: MovePlace = machine ? { id: machine, name: machines.find((m) => m.id === machine)?.name ?? 'that computer' } : { name: hereName };
  const targets: MoveTarget[] = [
    ...(machine ? [{ place: { name: hereName } }] : []),
    ...machines.filter((m) => m.id !== machine && m.status !== 'offline' && !m.readOnly).map((m) => ({ place: { id: m.id, name: m.name }, machine: m })),
  ];
  return {
    none: !machines.length,
    from,
    fromClient: client,
    targets,
    clientFor: async (t) => (t.machine ? clientOf(t.machine, { home, windowUi: ui.windowStore }) : home),
    projectOn: (t, to, project, say) => (t.machine ? projectReadyOn(to, t.machine, project, () => say(`Getting ${project.name} ready on ${t.place.name}…`)) : projectHere(home, project)),
  };
}
