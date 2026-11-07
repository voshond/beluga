import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
export { formatBytes } from '../shared/format.js';

/**
 * Bytes used by a folder (du), or undefined when it can't be measured in time. du runs at the
 * lowest CPU priority (BLG-407), so it never takes the computer from you or Claude; same number.
 * Windows has no du on the daemon's PATH (and Git's du.exe crawls a big worktree for minutes),
 * so there the folder is walked in Node instead.
 */
export function folderSize(dir: string, timeoutMs = 30_000): Promise<number | undefined> {
  const run = (cmd: string, args: readonly string[]): Promise<{ missing: boolean; size: number | undefined }> =>
    new Promise((resolve) => {
      execFile(cmd, [...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        // du exits non-zero on unreadable subfolders but still prints a total.
        const kb = Number(/^(\d+)/.exec(stdout ?? '')?.[1]);
        resolve({ missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT', size: Number.isFinite(kb) && kb >= 0 ? kb * 1024 : undefined });
      });
    });
  if (process.platform === 'win32') return walkSize(dir, timeoutMs);
  // No nice here (a trimmed-down system): du as it is.
  return run('nice', ['-n', '19', 'du', '-sk', dir]).then((r) => (r.missing ? run('du', ['-sk', dir]).then((d) => d.size) : r.size));
}

/**
 * Bytes used by a folder, walked in Node: every regular file, rounded up to whole KiB like
 * `du -sk`; symlinks and junctions aren't followed, unreadable subfolders are skipped. Past the
 * time budget it answers with what it has counted so far (a number, so the UI stops waiting).
 * Undefined only when the folder itself can't be read.
 *
 * Windows has no du of its own. The nearest is a PowerShell one-liner
 * (`Get-ChildItem -Recurse -Force -File | Measure-Object Length -Sum`), which does the same sum
 * in a few seconds, but it means starting powershell.exe (a second or more each time) for every
 * workspace, every 5 minutes; this walk does the same work in-process, with nothing to spawn.
 */
export async function walkSize(dir: string, timeoutMs = 30_000): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  const kib = (bytes: number): number => Math.ceil(bytes / 1024) * 1024;
  let total = 0;
  const pending = [dir];
  let first = true;
  while (pending.length && Date.now() < deadline) {
    const folder = pending.pop()!;
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      if (first) return undefined;
      continue;
    }
    first = false;
    const files: string[] = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) pending.push(path.join(folder, e.name));
      else if (e.isFile()) files.push(path.join(folder, e.name));
    }
    const sizes = await Promise.all(files.map((f) => stat(f).then((s) => s.size, () => 0)));
    for (const s of sizes) total += kib(s);
  }
  return total;
}

/**
 * Measure folders one at a time (so a dozen worktrees don't hammer the disk at once). `onEach`
 * hears every size as it comes, so a screen needn't wait for the whole round (a big main folder
 * can take the full time budget).
 */
export async function measureAll(dirs: ReadonlyArray<{ id: string; path: string }>, measure = folderSize, onEach?: (id: string, size: number) => void): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const d of dirs) {
    const size = await measure(d.path);
    if (size === undefined) continue;
    out[d.id] = size;
    onEach?.(d.id, size);
  }
  return out;
}
