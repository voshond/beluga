import type { NoticeEvent } from '../src/core/notify.js';
import type { SentinelDraft } from '../src/core/sentinel/model.js';
import type { SentinelClaude, SentinelPlaces, SentinelShell, ShellResult } from '../src/core/sentinel/runner.js';
import { Sentinels, type SentinelsDeps } from '../src/core/sentinel/sentinels.js';
import { Store, type WrittenBy, initialState } from '../src/core/store.js';
import type { Project } from '../src/workspaces/types.js';

/** Fakes for Sentinel's tests: your Claude, the places it works, a shell, notifications. */

export const project = (id: string, name: string): Project => ({ id, name, root: `/code/${name}`, base: 'main', workspaces: [] });

export interface Asked {
  readonly prompt: string;
  readonly channel: string;
  readonly requestId: string;
  readonly written?: WrittenBy;
  answer(text: string): void;
  fail(why: string): void;
}

/** Your Claude: every ask is kept; `reply` answers at once (or not: undefined leaves it running). */
export function fakeClaude(reply?: (asked: Asked) => string | undefined, opts: { readonly holdCancel?: boolean } = {}) {
  const asked: Asked[] = [];
  const cancelled: Array<[string, string]> = [];
  const waits = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>();
  const early = new Map<string, { ok: boolean; text: string }>();
  let n = 0;
  const settle = (id: string, ok: boolean, text: string): void => {
    const w = waits.get(id);
    if (!w) return void early.set(id, { ok, text });
    waits.delete(id);
    if (ok) w.resolve(text);
    else w.reject(new Error(text));
  };
  const claude: SentinelClaude = {
    ask: (prompt, channel, _shown, written) => {
      const requestId = `rq${++n}`;
      const a: Asked = { prompt, channel, requestId, ...(written ? { written } : {}), answer: (t) => settle(requestId, true, t), fail: (w) => settle(requestId, false, w) };
      asked.push(a);
      const said = reply?.(a);
      if (said !== undefined) queueMicrotask(() => a.answer(said));
      return requestId;
    },
    wait: (requestId) =>
      new Promise<string>((resolve, reject) => {
        const got = early.get(requestId);
        if (got) {
          early.delete(requestId);
          return got.ok ? resolve(got.text) : reject(new Error(got.text));
        }
        waits.set(requestId, { resolve, reject });
      }),
    // As your Claude does: a cancelled request ends with an error (holdCancel: not until the test says).
    cancel: (requestId, note) => {
      cancelled.push([requestId, note]);
      if (!opts.holdCancel) settle(requestId, false, 'Stopped');
    },
  };
  return { claude, asked, cancelled };
}

export function fakePlaces(opts: { readonly changes?: boolean } = {}) {
  const archived: string[] = [];
  const made: Array<{ kind: string; projectId?: string; name: string }> = [];
  let n = 0;
  const places: SentinelPlaces = {
    projectChat: async (projectId, title) => {
      made.push({ kind: 'chat', projectId, name: title });
      const id = `c${++n}`;
      return { channel: `ws:${id}`, workspaceId: id };
    },
    worktree: async (projectId, name) => {
      made.push({ kind: 'worktree', projectId, name });
      const id = `w${++n}`;
      return { channel: `ws:${id}`, workspaceId: id };
    },
    macChat: () => {
      made.push({ kind: 'mac', name: 'mac' });
      return { channel: `mac:assistant:m${++n}` };
    },
    madeChanges: async () => opts.changes ?? false,
    archive: async (id) => void archived.push(id),
  };
  return { places, archived, made };
}

export function fakeShell(result: (command: string, env: Record<string, string>) => Partial<ShellResult> | 'hang' = () => ({ exitCode: 0, output: 'ok\n' })) {
  const ran: Array<{ command: string; cwd: string; timeoutMs: number; env: Record<string, string> }> = [];
  const shell: SentinelShell = (command, cwd, timeoutMs, env, signal) => {
    ran.push({ command, cwd, timeoutMs, env });
    const r = result(command, env);
    if (r === 'hang') return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ output: 'killed', truncated: false, timedOut: false, ms: 1 })));
    return Promise.resolve({ exitCode: 0, output: '', truncated: false, timedOut: false, ms: 2100, ...r });
  };
  return { shell, ran };
}

export function setup(deps: Partial<SentinelsDeps> & { readonly reply?: (a: Asked) => string | undefined; readonly changes?: boolean; readonly holdCancel?: boolean } = {}) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('api', 'bob-api'), project('land', 'landing')] });
  const notices: NoticeEvent[] = [];
  const c = fakeClaude(deps.reply, { ...(deps.holdCancel ? { holdCancel: true } : {}) });
  const p = fakePlaces({ ...(deps.changes !== undefined ? { changes: deps.changes } : {}) });
  const sh = fakeShell();
  const sentinels = new Sentinels({
    store,
    dir: null,
    selfId: () => 'p-me',
    claude: c.claude,
    places: p.places,
    shell: sh.shell,
    envFor: () => ({ GREETING: 'hello' }),
    notify: (e) => void notices.push(e),
    home: '/home/me',
    tickMs: 0,
    ...deps,
  });
  return { store, sentinels, notices, ...c, ...p, ran: sh.ran };
}

/** Wait until it's true (async work settles), or fail after a moment. */
export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 1));
  }
}

export const brief: SentinelDraft = {
  name: 'Morning brief',
  projectId: 'api',
  trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' },
  steps: [
    { kind: 'claude', name: 'Read what changed', where: 'project', prompt: 'Brief for {{project}} on {{date}}' },
    { kind: 'notify', name: 'Tell me', phone: true },
  ],
};
