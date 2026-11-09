import { useSyncExternalStore } from 'react';
import type { View } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { MachineView } from '@beluga/machines/machines.js';
import type { ReadyRun } from '@beluga/machines/ready-model.js';
import { readyLine } from '@beluga/machines/ready-model.js';
import { type Route, projectThere, routeWork } from '@beluga/machines/route.js';
import { toast, type UiStore, useBeluga } from '../lib/beluga.js';
import { useActions } from '../lib/actions.js';
import { thisComputer, upFirst } from '../lib/os-words.js';
import { runsOnFor } from '../chat/RunsOn.js';
import { ensureMachine, machineClientOf } from './pane-clients.js';
import { onMachine, paneOf, sameView } from './pane-model.js';
import { currentMachines } from './use-machines.js';
import { holdReason } from './runs-on-model.js';
import { noteStarted } from './started.js';

/**
 * Start the work on that computer (BLG-788): Runs on picked one of your computers, so the new
 * worktree, chat, plan or sentinel is made there, in the same project: found by its git origin (or
 * name), or made ready there first (folder, clone, tools, setup, each step shown), then made with
 * that computer's client and opened at once in the pane, tagged with its computer.
 */

export type WorkToStart =
  | { readonly kind: 'worktree'; readonly text: string; readonly opts: Record<string, unknown> }
  | { readonly kind: 'chat'; readonly text: string }
  | { readonly kind: 'plan'; readonly input: { readonly goal: string } & Record<string, unknown> }
  /** `ask`: words its Claude fills it in from (Describe It); `then`: a recipe's second one, run after it. */
  | { readonly kind: 'sentinel'; readonly draft: Record<string, unknown>; readonly ask?: string; readonly then?: { readonly draft: Record<string, unknown>; readonly on: string } };

export interface Starting {
  readonly machine: MachineView;
  /** What's being started, in words ("a worktree in bob-api"). */
  readonly what: string;
  readonly phase: 'connecting' | 'ready' | 'starting' | 'failed';
  /** Getting the project ready there (its steps). */
  readonly run?: ReadyRun;
  /** The computer's client, once it's there (GettingReady follows the run with it). */
  readonly client?: SocketClient;
  readonly error?: string;
  /** The window still shows it (going elsewhere leaves it to finish on its own). */
  readonly shown: boolean;
  /** Where the window was when it started. */
  readonly from: View;
}

let current: Starting | undefined;
const listeners = new Set<() => void>();
const set = (next: Starting | undefined): void => {
  current = next;
  for (const l of [...listeners]) l();
};
const patch = (p: Partial<Starting>): void => {
  if (current) set({ ...current, ...p });
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** What's starting on a computer now, while the window shows it (Main draws its page instead). */
export function useStarting(view: View): Starting | undefined {
  const s = useSyncExternalStore(subscribe, () => current);
  // Going elsewhere: it goes on by itself, and says when it's done.
  if (s && s.shown && !sameView(s.from, view)) {
    queueMicrotask(() => current === s && patch({ shown: false }));
    return undefined;
  }
  return s?.shown ? s : undefined;
}

/** Leave the page (it isn't started: nothing to undo; a run there goes on). */
export const dismissStarting = (): void => set(undefined);

export interface StartDeps {
  readonly home: SocketClient;
  readonly windowUi: UiStore;
  /** Show a page the way the window does. */
  readonly go: (view: View) => void;
  /** Made from a computer's own page: it's that computer's work already (its client makes it). */
  readonly machine?: string;
}

/**
 * Where work in `project` (this Mac's id) goes now: Runs on's last pick there, else Run New Work
 * On. On a computer's own page (`inMachine`) the work is that computer's already: here.
 */
export function routeFor(home: SocketClient, project: { readonly id?: string; readonly name: string; readonly origin?: string } | undefined, runtime: string): Route {
  const machines = currentMachines();
  if (!machines.length) return { where: 'here' };
  const runsOn = runsOnFor(project?.id, home.store.getState().prefs.runOn, machines);
  return routeWork({ runsOn, machines, hereName: upFirst(thisComputer()), runtime, ...(project ? { project: { name: project.name, ...(project.origin ? { origin: project.origin } : {}) } } : {}) });
}

const CONNECT_MS = 20_000;
const POLL_MS = 700;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function clientOf(machine: MachineView, d: Pick<StartDeps, 'home' | 'windowUi'>): Promise<SocketClient> {
  ensureMachine(machine.id, d.home, d.windowUi);
  const until = Date.now() + CONNECT_MS;
  for (;;) {
    const c = machineClientOf(machine.id);
    if (c) return c;
    if (Date.now() > until) throw new Error(`${machine.name} can’t be reached right now`);
    await sleep(150);
  }
}

/** The project's id on that computer: there already, or made ready there (each step shown). */
async function projectOn(client: SocketClient, machine: MachineView, project: { readonly id: string; readonly name: string }, d: StartDeps): Promise<string> {
  const origin = ((await d.home.call('projects.origin', project.id).catch(() => null)) as string | null) ?? undefined;
  return projectReadyOn(client, machine, { name: project.name, ...(origin ? { origin } : {}) }, (run) => patch({ phase: 'ready', run, client }));
}

/**
 * A project (by its git origin, else its name) on a computer: there already, or got ready there
 * from its origin, each step of that run told to `onRun` → its id there. Move To uses it too (BLG-806).
 */
export async function projectReadyOn(client: SocketClient, machine: MachineView, project: { readonly name: string; readonly origin?: string }, onRun?: (run: ReadyRun) => void): Promise<string> {
  const { origin } = project;
  // There already: the project with the same origin (as the computer reports its projects), else the same name.
  const named = projectThere(machine, project) ?? project.name;
  const known = client.store.getState().projects.find((p) => p.name === named && p.root);
  if (known) return known.id;
  // Not there: the computer gets it ready from its origin.
  if (!origin) throw new Error(`${project.name} has no git origin here to get it from, so ${machine.name} can’t get it`);
  let run = (await client.call('machines.ready.start', origin, project.name)) as ReadyRun;
  onRun?.(run);
  while (run.state !== 'done') {
    if (run.state === 'failed') throw new Error(readyLine(run));
    await sleep(POLL_MS);
    const next = (await client.call('machines.ready.status', run.id).catch(() => undefined)) as ReadyRun | null | undefined;
    if (!next) throw new Error(`${machine.name} stopped getting ${project.name} ready`);
    run = next;
    onRun?.(run);
  }
  if (!run.projectId) throw new Error(`${machine.name} got ${project.name} ready, but it isn’t listed there`);
  return run.projectId;
}

/** Make it with the computer's client → its page there. */
async function make(client: SocketClient, projectId: string | undefined, what: WorkToStart): Promise<View> {
  switch (what.kind) {
    case 'worktree': {
      const id = (await client.call('workspaces.startWorktree', projectId!, what.text, what.opts as never)) as string | undefined;
      if (!id) throw new Error('The worktree wasn’t made there');
      return { kind: 'workspace', id, tab: 'chat' };
    }
    case 'chat': {
      // In the project there, or (none) in the computer's own chats, outside any project.
      const space = projectId ?? 'chats';
      const before = new Set(client.store.getState().projects.flatMap((p) => p.workspaces.map((w) => w.id)));
      await client.call('workspaces.startChat', space, what.text);
      // The computer shows its new chat on the screen that asked; else the chat that wasn't there before.
      const shown = client.store.getState().view;
      if (shown.kind === 'workspace' && !before.has(shown.id)) return shown;
      const made = client.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.kind === 'chat' && !before.has(w.id));
      if (made) return { kind: 'workspace', id: made.id, tab: 'chat' };
      return projectId ? { kind: 'project', id: projectId } : { kind: 'assistant' };
    }
    case 'plan': {
      const plan = (await client.call('plans.create', { ...what.input, projectId: projectId! } as never)) as { id: string };
      return { kind: 'plan', id: plan.id };
    }
    case 'sentinel': {
      const made = (await client.call('sentinel.create', { ...what.draft, projectId: projectId ?? null } as never)) as { id: string } | undefined;
      if (!made?.id) throw new Error('The sentinel wasn’t made there');
      if (what.then) await client.call('sentinel.create', { ...what.then.draft, projectId: projectId ?? null, trigger: { kind: 'after', sentinelId: made.id, on: what.then.on } } as never);
      if (what.ask) void client.call('sentinel.ask', made.id, what.ask).catch(() => undefined);
      return { kind: 'sentinel_page', id: made.id };
    }
  }
}

/**
 * Start `what` on `machine`, in this Mac's `project` (none: work outside a project). Shows its page
 * while it gets there; opens what it made there at once (or, if you went elsewhere, says so).
 */
export async function startThere(d: StartDeps, machine: MachineView, project: { readonly id: string; readonly name: string } | undefined, what: WorkToStart): Promise<boolean> {
  const words = what.kind === 'worktree' ? 'a worktree' : what.kind === 'chat' ? 'a chat' : what.kind === 'plan' ? 'a plan' : 'a sentinel';
  set({ machine, what: project ? `${words} in ${project.name}` : words, phase: 'connecting', shown: true, from: d.home.store.getState().view });
  try {
    const client = await clientOf(machine, d);
    patch({ client });
    const projectId = project ? await projectOn(client, machine, project, d) : undefined;
    patch({ phase: 'starting' });
    const page = await make(client, projectId, what);
    if (page.kind === 'workspace') noteStarted(machine.id, `ws:${page.id}`);
    const shown = current?.shown ?? false;
    set(undefined);
    if (shown || paneOf(d.home.store.getState().view).machine === machine.id) d.go(onMachine(machine.id, page));
    else toast(d.home, `${upFirst(words)} started on ${machine.name}`, 'success');
    return true;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (current?.shown) patch({ phase: 'failed', error });
    else {
      set(undefined);
      toast(d.home, `Couldn’t start ${words} on ${machine.name}: ${error}`, 'error');
    }
    return false;
  }
}

/** What a view that makes work needs to send it to a computer. */
export function useStartDeps(): StartDeps {
  const { home, ui, machine } = useBeluga();
  const actions = useActions();
  return { home, windowUi: ui.windowStore, go: (view) => actions.run({ type: 'view', view }), ...(machine ? { machine } : {}) };
}

/** Sent to a computer; held (the chip names a computer that can't take it now: nothing starts, the words stay); or here. */
export type Sent = 'sent' | 'held' | 'here';

/**
 * Where Runs on sends work in this Mac's `projectId` ('chats' or none: outside a project, `folder`:
 * a folder chat's folder on this Mac): started there ('sent'); held when the chip names a computer
 * that can't take it, said in words and nothing started ('held'); or made here by the caller ('here').
 */
export function sendToComputer(d: StartDeps, projectId: string | undefined, runtime: string, what: WorkToStart, folder?: string): Sent {
  if (d.machine) return 'here';
  const project = projectId && projectId !== 'chats' ? d.home.store.getState().projects.find((p) => p.id === projectId) : undefined;
  const machines = currentMachines();
  const route = routeFor(d.home, project ? { id: project.id, name: project.name } : undefined, runtime);
  const why = holdReason(route, runsOnFor(project?.id, d.home.store.getState().prefs.runOn, machines), machines, runtime, upFirst(thisComputer()), folder);
  if (why) {
    toast(d.home, why, 'warn');
    return 'held';
  }
  if (route.where === 'here') {
    if (route.why) toast(d.home, route.why, 'info');
    return 'here';
  }
  void startThere(d, route.machine, project ? { id: project.id, name: project.name } : undefined, what);
  return 'sent';
}
