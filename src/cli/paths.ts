import os from 'node:os';
import path from 'node:path';

/** A path as people write it: the home folder as ~. */
export function tilde(p: string, home: string = os.homedir()): string {
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
