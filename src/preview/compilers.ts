import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { COMPILE_CHILD } from './compile-child.js';

/**
 * The project's own compilers (Tailwind, Vue, Svelte) run the project's code, so they run in a
 * process of their own per worktree, never the daemon: Node's permission model lets it read only
 * the worktree and the packages it uses (node_modules folders from it up, links followed), never
 * write, start anything or open workers. It exits a minute after its last job, and all of them
 * stop with the previews (manager.ts rest).
 */

export type CompileKind = 'tailwind' | 'vue' | 'svelte' | 'svelte-host';
export interface CompileRequest {
  readonly kind: CompileKind;
  readonly file: string;
  /** Tailwind's or Svelte's major version. */
  readonly major?: number;
}
export interface CompileAnswer {
  readonly contents?: string;
  readonly loader?: 'css' | 'js' | 'ts';
  /** Nothing to do (a Tailwind stylesheet it can't build): left to esbuild. */
  readonly skip?: boolean;
  readonly errors?: ReadonlyArray<{ readonly text: string; readonly location?: { readonly file: string; readonly line?: number; readonly column?: number } }>;
}

/** How long one job may take (a Tailwind scan of a big worktree included). */
const JOB_MS = 60_000;

interface Child {
  readonly proc: ChildProcess;
  readonly pending: Map<number, (a: CompileAnswer) => void>;
}

const children = new Map<string, Child>();
let next = 0;

/** What the process may read: the worktree, and every node_modules from it up (each one's real place too). */
export function readable(root: string): string[] {
  const out = new Set<string>();
  const real = (p: string): string | undefined => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const base = real(root) ?? root;
  out.add(base);
  for (let dir = base; ; dir = path.dirname(dir)) {
    const modules = path.join(dir, 'node_modules');
    if (existsSync(modules)) {
      out.add(modules);
      const r = real(modules);
      if (r) out.add(r);
    }
    if (path.dirname(dir) === dir) break;
  }
  return [...out];
}

function start(root: string): Child {
  const flags = ['--permission', ...readable(root).map((p) => `--allow-fs-read=${p}`), '--allow-addons', '--input-type=module', '-e', COMPILE_CHILD];
  const proc = spawn(process.execPath, flags, { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { NODE_ENV: 'production' } });
  const child: Child = { proc, pending: new Map() };
  proc.on('message', (raw) => {
    const msg = raw as CompileAnswer & { id: number };
    const done = child.pending.get(msg.id);
    child.pending.delete(msg.id);
    done?.(msg);
  });
  proc.on('exit', () => {
    if (children.get(root) === child) children.delete(root);
    for (const done of child.pending.values()) done({ errors: [{ text: 'The compiler stopped' }] });
    child.pending.clear();
  });
  proc.on('error', () => undefined);
  // Its own output is for nobody: drained, so it never blocks.
  proc.stderr?.resume();
  proc.unref();
  children.set(root, child);
  return child;
}

/** One job in the worktree's compiler process (started when needed). */
export function compileIn(worktree: string, request: CompileRequest): Promise<CompileAnswer> {
  // Its real place: the process may read only real paths (a /tmp worktree is /private/tmp).
  let root = worktree;
  try {
    root = realpathSync(worktree);
  } catch {
    /* gone: the job says so */
  }
  let file = request.file;
  try {
    file = realpathSync(request.file);
  } catch {
    /* a virtual one (Svelte's host): as it is */
  }
  const child = children.get(root) ?? start(root);
  const id = ++next;
  return new Promise<CompileAnswer>((resolve) => {
    const timer = setTimeout(() => {
      child.pending.delete(id);
      resolve({ errors: [{ text: 'The compiler took too long' }] });
    }, JOB_MS);
    timer.unref();
    child.pending.set(id, (a) => {
      clearTimeout(timer);
      resolve(a);
    });
    try {
      child.proc.send({ id, root, ...request, file });
    } catch {
      child.pending.delete(id);
      clearTimeout(timer);
      resolve({ errors: [{ text: 'The compiler stopped' }] });
    }
  });
}

/** Every compiler process stopped (no preview left, the daemon stopping). */
export function stopCompilers(): void {
  for (const child of children.values()) child.proc.kill();
  children.clear();
}

/** How many are running (tests). */
export const compilersRunning = (): number => children.size;
