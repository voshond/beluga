/**
 * One repository however its origin is written (BLG-787): `git@github.com:o/r.git`,
 * `https://github.com/o/r`, `ssh://git@github.com/o/r.git` are the same `github.com/o/r`. How a
 * project on one computer is found on another. Browser-safe.
 */

/** The host and the repository's path, as written (none: not a git address). */
function partsOf(origin: string): { readonly host: string; readonly path: string } | undefined {
  const raw = origin.trim();
  if (!raw) return undefined;
  // scp-like: user@host:path
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(raw);
  let host: string;
  let path: string;
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const url = new URL(raw);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
      host = url.hostname;
      path = url.pathname;
    } catch {
      return undefined;
    }
  }
  const clean = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return host && clean ? { host, path: clean } : undefined;
}

export function repoKey(origin: string): string | undefined {
  const p = partsOf(origin);
  return p ? `${p.host.toLowerCase()}/${p.path.toLowerCase()}` : undefined;
}

/** The same repository. */
export const sameRepo = (a: string, b: string): boolean => {
  const k = repoKey(a);
  return k !== undefined && k === repoKey(b);
};

/** The repository's own name (the folder a clone makes): `bob-api`. */
export function repoName(origin: string): string | undefined {
  const name = partsOf(origin)?.path.split('/').pop();
  return name && /^[\w.-]+$/.test(name) && !name.startsWith('.') ? name : undefined;
}

/** `owner/repo` on GitHub (gh clones it with its own sign-in), else undefined. */
export function githubSlug(origin: string): string | undefined {
  const p = partsOf(origin);
  if (!p || p.host.toLowerCase() !== 'github.com') return undefined;
  return /^[\w.-]+\/[\w.-]+$/.test(p.path) ? p.path : undefined;
}

/** An origin Beluga may hand to git: a URL or scp-like address, no spaces, never an option. */
export const cloneableOrigin = (origin: string): boolean => origin.length <= 500 && !/\s/.test(origin) && !origin.startsWith('-') && partsOf(origin) !== undefined;
