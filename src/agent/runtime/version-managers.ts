import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/**
 * Version managers (mise, asdf) put a CLI on PATH as a shim. `mise activate` adds its install
 * folders from a prompt hook, which never runs in the `$SHELL -ilc` the Mac app reads your PATH
 * from, so a tool installed with one can be missing from the daemon's PATH (#548). Their shim
 * folders are where it still is. (POSIX only: Windows starts apps with your PATH already.)
 */
export function versionManagerShimDirs(env: Readonly<Record<string, string | undefined>>, home: string): string[] {
  const p = path.posix;
  const mise = env.MISE_DATA_DIR || p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'mise');
  const asdf = env.ASDF_DATA_DIR || p.join(home, '.asdf');
  return [p.join(mise, 'shims'), p.join(asdf, 'shims')];
}

/** A mise shim, seen through its link: mise itself, a multi-call binary that reads its own name to know what to run. */
export const isMiseBinary = (realFile: string): boolean => /^mise(\.exe)?$/i.test(path.basename(realFile));

const WHICH_TIMEOUT_MS = 5_000;

const runs = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The installed tool a mise shim stands for, as mise picks it in `cwd` (a project may pin its own
 * version): `mise which <tool>`. Undefined when mise can't say.
 */
export function miseWhich(mise: string, tool: string, opts: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> }): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(mise, ['which', tool], { cwd: opts.cwd, env: { ...opts.env }, timeout: WHICH_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      const found = err ? undefined : stdout.split('\n')[0]?.trim();
      resolve(found && path.isAbsolute(found) && runs(found) ? found : undefined);
    });
  });
}
