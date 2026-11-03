import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DaemonInfo } from '../ipc/protocol.js';
import { belugaHome } from '../workspaces/store.js';

/** Where the running daemon says how to reach it (port, token). Only you can read it. */
export const daemonInfoPath = (): string => path.join(belugaHome(), 'daemon.json');
/** Held while a daemon is starting, so two screens opening at once start only one. */
export const daemonLockPath = (): string => path.join(belugaHome(), 'daemon.lock');
export const daemonLogPath = (): string => path.join(belugaHome(), 'logs', 'daemon.log');

/** Past this, daemon.log is set aside as daemon.log.1 and started over, so the two stay under twice it. */
export const LOG_LIMIT = 5 * 1024 * 1024;

/** Whether a process with this pid is alive (and ours to signal). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readDaemonInfo(file = daemonInfoPath()): DaemonInfo | undefined {
  try {
    const parsed = DaemonInfo.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The running daemon, if daemon.json points at a live one. */
export function runningDaemon(file = daemonInfoPath()): DaemonInfo | undefined {
  const info = readDaemonInfo(file);
  return info && alive(info.pid) ? info : undefined;
}

export function writeDaemonInfo(info: DaemonInfo, file = daemonInfoPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Remove daemon.json, but only if it's still about this process. */
export function clearDaemonInfo(pid = process.pid, file = daemonInfoPath()): void {
  if (readDaemonInfo(file)?.pid === pid) rmSync(file, { force: true });
}

/**
 * Take the start-up lock (true), or learn that another live process holds it (false).
 * A lock left by a process that died is taken over.
 */
export function takeLock(file = daemonLockPath()): boolean {
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number(readFileSync(file, 'utf8').trim());
      if (Number.isFinite(holder) && holder > 0 && alive(holder)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

export function releaseLock(file = daemonLockPath()): void {
  try {
    if (Number(readFileSync(file, 'utf8').trim()) === process.pid) rmSync(file, { force: true });
  } catch {
    // Not ours, or already gone.
  }
}

/** The daemon's log, started fresh (the old one kept as daemon.log.1) once it's grown past 5 MB. */
export function openDaemonLog(file = daemonLogPath()): number {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
  return openSync(file, 'a', 0o600);
}
