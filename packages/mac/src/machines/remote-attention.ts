import { useEffect, useSyncExternalStore } from 'react';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { Counts } from '@beluga/machines/attention.js';
import type { MachineView } from '@beluga/machines/machines.js';
import { isDemoMachine } from '@beluga/machines/demo.js';
import { dockCount, workingCount } from '../layout/attention-model.js';
import { type Waiting, bellCount, waitingList } from '../layout/waiting-model.js';
import { type NeedsThere, needsThere, overviewItems } from '../views/overview/overview-model.js';
import { machineClientOf, onMachines } from './pane-clients.js';
import { currentMachines, useMachines } from './use-machines.js';

/**
 * One bell for every computer (BLG-790): what waits for you on each computer whose screen is open,
 * and its counts for the bell, the Dock and the menu bar, taken from its state at most once a
 * second. This Mac's own are counted where they always were; these are added to them.
 */

export interface RemoteAttention {
  readonly machine: MachineView;
  readonly waiting: readonly Waiting[];
  /** The bell's count there: what waits, and unread notices not about one of those. */
  readonly bell: number;
  readonly counts: Counts;
  /** Its worktrees and plans that need you, for the Overview's Needs You (BLG-843). */
  readonly needs: readonly NeedsThere[];
}

const EVERY_MS = 1000;
let all: readonly RemoteAttention[] = [];
const byMachine = new Map<string, RemoteAttention>();
const listeners = new Set<() => void>();
const watching = new Map<string, () => void>();

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function publish(): void {
  all = [...byMachine.values()];
  for (const l of [...listeners]) l();
}

function take(machine: MachineView, client: SocketClient): void {
  const st = client.store.getState();
  const waiting = waitingList(st);
  byMachine.set(machine.id, {
    machine,
    waiting,
    bell: bellCount(st, waiting),
    counts: { new: dockCount(st), waiting: st.approvals.length + st.questions.length + st.knocks.length, working: workingCount(st) },
    needs: needsThere(overviewItems(st)),
  });
  publish();
}

function watch(machine: MachineView, client: SocketClient): () => void {
  let seen: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = (): void => {
    timer = undefined;
    const st = client.store.getState();
    if (st === seen) return;
    seen = st;
    take(machine, client);
  };
  tick();
  const off = client.store.subscribe(() => {
    timer ??= setTimeout(tick, EVERY_MS);
  });
  return () => {
    clearTimeout(timer);
    off();
    if (byMachine.delete(machine.id)) publish();
  };
}

function sync(): void {
  // A demo computer is this daemon (src/machines/demo.ts): what waits there is this Mac's, counted once already.
  for (const m of currentMachines().filter((x) => !isDemoMachine(x.id))) {
    const client = machineClientOf(m.id);
    if (client && !watching.has(m.id)) watching.set(m.id, watch(m, client));
    if (!client && watching.has(m.id)) {
      watching.get(m.id)!();
      watching.delete(m.id);
    }
  }
}

/** Follow every computer's attention while the window runs (mounted once, App). */
export function useRemoteAttentionWatch(home: SocketClient): void {
  const machines = useMachines(home);
  useEffect(() => {
    sync();
    const off = onMachines(sync);
    return () => {
      off();
      for (const stop of watching.values()) stop();
      watching.clear();
    };
  }, [machines]);
}

/** Every computer's: what waits there and its counts (only those whose screen is open). */
export function useRemoteAttention(): readonly RemoteAttention[] {
  return useSyncExternalStore(subscribe, () => all);
}

/** The same, outside a view (the Dock and the menu bar), and hearing it change. */
export const remoteAttention = (): readonly RemoteAttention[] => all;
export const onRemoteAttention = subscribe;
