import { experimentOn } from '../shared/experiments.js';
import type { Session } from '../core/session.js';
import os from 'node:os';
import { placeNewWork } from '../machines/placement.js';
import { machinesOf, needMachines } from '../machines/registry.js';
import { needAlwaysOn } from '../machines/always-on.js';
import { readyingOf } from '../machines/ready.js';
import { runOnHere } from '../machines/run-on.js';
import { envHere, needEnvSend, receiveEnv } from '../machines/env-send.js';
import { checkDrop, downloadThere, readPieceHere, receivePiece, sendPiece } from '../machines/uploads.js';
import { editorHere } from '../machines/open.js';
import { DEFAULT_DOWNLOAD_DIR } from '../core/downloads.js';
import { existsSync } from 'node:fs';
import { portsByFolder } from '../workspaces/ports.js';
import { type MachinePort, type MachinePorts, needForwarder } from '../machines/forward.js';

/** On a computer: each worktree's listening ports, from one look at the OS, and its live previews' server. */
async function machinePorts(
  state: { readonly projects: readonly { readonly workspaces: readonly { readonly id: string; readonly path: string }[] }[] },
  preview?: { readonly port: number; readonly roots: readonly string[] },
): Promise<MachinePorts> {
  const workspaces = state.projects.flatMap((p) => p.workspaces).filter((w) => w.path);
  const byFolder = await portsByFolder([...new Set(workspaces.map((w) => w.path))]);
  const seen = new Set<string>();
  const ports = workspaces.flatMap((w): MachinePort[] => {
    if (seen.has(w.path)) return [];
    seen.add(w.path);
    return [...(byFolder.get(w.path) ?? []).map((p) => ({ workspaceId: w.id, port: p.port, name: p.name })), ...(preview?.roots.includes(w.path) ? [{ workspaceId: w.id, port: preview.port, name: 'Live preview' }] : [])];
  });
  return { worktrees: workspaces.map((w) => w.id), ports };
}

/** Live previews' server here, when previews are on and one is live (their code isn't loaded otherwise). */
async function previewServing(s: Session): Promise<{ readonly port: number; readonly roots: readonly string[] } | undefined> {
  if (!experimentOn(s.store.getState().prefs.experiments, 'previews')) return undefined;
  const { previews } = await import('../preview/manager.js');
  return previews().serving();
}

/** This computer's 1-minute load per core, as a computer reports its own. */
const hereLoad = (): number => Math.round(((os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length)) * 100) / 100;
import type { Args, Method } from './api.js';

/** What each `machines.*` method does (see machine-api.ts). Results carry no keys beyond a pairing's own link and code. */

type MachineMethod = Extract<Method, `machines.${string}`>;
type MachineHandlers = { readonly [M in MachineMethod]: (s: Session, ...args: Args<M>) => unknown };

export const MACHINE_HANDLERS = {
  'machines.pair.start': (s) => needMachines(s).pairStart(),
  'machines.pair.status': (s) => needMachines(s).pairStatus(),
  'machines.pair.cancel': (s) => needMachines(s).pairCancel(),
  'machines.join.start': (s, ticket) => needMachines(s).joinStart(ticket),
  'machines.join.approve': (s) => needMachines(s).joinApprove(),
  'machines.join.cancel': (s) => needMachines(s).joinCancel(),
  'machines.ssh.hosts': (s) => needMachines(s).sshHosts(),
  'machines.ssh.pair': (s, host) => needMachines(s).sshPairStart(host),
  'machines.update': (s, id, mode) => needMachines(s).update(id, mode),
  'machines.leftBehind': (s, ipc) => needMachines(s).leftBehind(ipc),
  'machines.look': (s, id, look) => needMachines(s).look(id, look),
  // Run New Work On as this device reads it: here on a computer, or when it names this device or one it doesn't know (BLG-836).
  'machines.placement': (s) => placeNewWork(runOnHere(s.store.getState().prefs.runOn, needMachines(s).runOnDevice()), needMachines(s).list(), { name: needMachines(s).hereName(), loadPerCore: hereLoad() }),
  'machines.list': (s) => needMachines(s).list(),
  'machines.devices': (s) => needMachines(s).devicesInSet(),
  'machines.forget': (s, id) => needMachines(s).forget(id),
  'machines.ready.start': (s, origin, name) => readyingOf(s, () => machinesOf(s)?.hereName() ?? os.hostname()).start(origin, name),
  'machines.ready.status': (s, id) => readyingOf(s).status(id) ?? null,
  'machines.ready.install': (s, id) => readyingOf(s).install(id),
  'machines.ports': async (s) => machinePorts(s.store.getState(), await previewServing(s)),
  'machines.forwards': (s) => s.store.getState().forwards,
  'machines.share': (s, wsId, port) => needForwarder(s).share(wsId, port),
  'machines.unshare': (s, wsId, port) => needForwarder(s).unshare(wsId, port),
  'machines.upload.put': (s, id, piece) => receivePiece(s, id, piece),
  'machines.upload.send': (s, id, n, file, off, opts) => sendPiece((method, args) => needMachines(s).door.call(id, method, args), n, file, off, opts?.env ? { env: true } : {}),
  'machines.upload.check': (_s, files) => Promise.all(files.map((f) => checkDrop(f))),
  'machines.download.piece': (_s, file, off) => readPieceHere(file, off),
  'machines.download.fetch': (s, id, file) => downloadThere((method, args) => needMachines(s).door.call(id, method, args), file, DEFAULT_DOWNLOAD_DIR),
  'machines.editor': () => editorHere(process.env, (app) => existsSync(app === 'cursor' ? '/Applications/Cursor.app' : '/Applications/Visual Studio Code.app')),
  'machines.env.here': (s, wsId) => envHere(s.store.getState(), wsId),
  'machines.env.receive': (s, wsIds, files) => receiveEnv(s.store.getState(), wsIds, files),
  'machines.env.decide': (s, askId, choice) => needEnvSend(s).decide(askId, choice),
  'machines.env.always': (s) => needEnvSend(s).always(),
  'machines.env.forget': (s, root) => needEnvSend(s).forget(root),
  'machines.secrets': (s, id, on) => needMachines(s).keepSecrets(id, on),
  'machines.settingsSync': (s) => needMachines(s).settingsSync(),
  'machines.settingsSync.clear': (s) => needMachines(s).clearSettingsConflicts(),
  'machines.alwaysOn': (s, target) => needAlwaysOn(s).make(target),
  'machines.alwaysOn.status': (s) => needAlwaysOn(s).view(),
} satisfies MachineHandlers;
