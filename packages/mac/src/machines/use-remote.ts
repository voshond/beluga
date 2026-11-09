import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { isDemoMachine } from '@beluga/machines/demo.js';
import type { MachineView } from '@beluga/machines/machines.js';
import { type UiStore, useBeluga } from '../lib/beluga.js';
import { ensureMachine, machineClientOf, onMachines } from './pane-clients.js';
import { type RemoteSnapshot, type RemoteSource, onlyItsWork, snapshotOf } from './remote-work.js';
import { useMachines } from './use-machines.js';
import { onStarted, startedOn } from './started.js';

/**
 * Every computer's work for this window's lists (BLG-785): a screen kept open to each computer
 * that's online, what it has taken from its state at most once a second, and the last of it kept
 * (here and across restarts) so an offline computer's items stay, greyed, with when it was seen.
 */

const KEY = 'beluga.remoteWork.v1';
const EVERY_MS = 1000;

interface Kept {
  readonly snapshot: RemoteSnapshot;
  readonly at: number;
}

let kept: Map<string, Kept> = read();
let version = 0;
const listeners = new Set<() => void>();
const watching = new Map<string, () => void>();
let saving: ReturnType<typeof setTimeout> | undefined;

function read(): Map<string, Kept> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as Record<string, Kept>;
    return new Map(Object.entries(raw).filter(([, v]) => v && typeof v.at === 'number' && v.snapshot && Array.isArray(v.snapshot.projects)));
  } catch {
    return new Map();
  }
}

function save(): void {
  clearTimeout(saving);
  saving = setTimeout(() => {
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {
      // Not kept past this window: the lists still show while it's open.
    }
  }, 2000);
}

function emit(): void {
  version++;
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Take what the lists need from a computer's state when it changed, at most once a second. */
function watch(machine: MachineView, client: SocketClient): () => void {
  let last: unknown[] = [];
  let force = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const take = (): void => {
    timer = undefined;
    const st = client.store.getState();
    const parts = [st.projects, st.plans, st.sentinel, st.board];
    if (!force && parts.every((p, i) => p === last[i])) return;
    force = false;
    last = parts;
    const all = snapshotOf(st);
    kept = new Map(kept).set(machine.id, { snapshot: isDemoMachine(machine.id) ? onlyItsWork(all, [...(machine.info?.work ?? []), ...startedOn(machine.id)]) : all, at: Date.now() });
    save();
    emit();
  };
  take();
  const off = client.store.subscribe(() => {
    timer ??= setTimeout(take, EVERY_MS);
  });
  // Work started there from this window counts as its own at once (a demo computer's, see started.ts).
  const offStarted = onStarted(() => {
    force = true;
    timer ??= setTimeout(take, 0);
  });
  return () => {
    clearTimeout(timer);
    off();
    offStarted();
  };
}

/** Keep a screen open to each online computer and its work taken as it changes (mounted once, App). */
export function useRemoteWork(home: SocketClient, windowUi: UiStore): void {
  const machines = useMachines(home);
  const online = machines.filter((m) => m.status === 'online').map((m) => m.id).join(',');
  useEffect(() => {
    for (const m of machines) if (m.status === 'online') ensureMachine(m.id, home, windowUi);
  }, [online, home, windowUi]);
  useEffect(() => {
    const sync = (): void => {
      for (const m of machines) {
        const client = machineClientOf(m.id);
        if (client && !watching.has(m.id)) watching.set(m.id, watch(m, client));
        if (!client && watching.has(m.id)) {
          watching.get(m.id)!();
          watching.delete(m.id);
          emit();
        }
      }
    };
    sync();
    const off = onMachines(sync);
    return () => {
      off();
      for (const stop of watching.values()) stop();
      watching.clear();
    };
  }, [machines, home]);
}

/** Every paired computer's work, live or as last seen (none paired: empty). */
export function useRemoteSources(): readonly RemoteSource[] {
  const { home } = useBeluga();
  const machines = useMachines(home);
  const v = useSyncExternalStore(subscribe, () => version);
  return useMemo(
    () =>
      machines.map((machine) => {
        const k = kept.get(machine.id);
        return { machine, live: watching.has(machine.id), ...(k ? { snapshot: k.snapshot, at: k.at } : {}) };
      }),
    [machines, v],
  );
}
