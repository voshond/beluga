import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attach } from '../src/cli/attach.js';
import { looksLikeToken, readClaudeToken, useClaudeToken } from '../src/cli/claude.js';
import type { Exit, Io } from '../src/cli/io.js';
import { type PairLink, pairLinkOf } from '../src/cli/pair.js';
import { projectLinkOf } from '../src/cli/project.js';
import { Cancelled, type Prompter, yesNo } from '../src/cli/prompt.js';
import { type SetupDeps, setup } from '../src/cli/setup.js';
import type { DeviceView } from '../src/companion/protocol.js';
import { parseConfig } from '../src/config.js';
import { Store, initialState } from '../src/core/store.js';
import { clearDaemonInfo, readDaemonInfo, releaseLock, runningDaemon } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import type { SocketClient } from '../src/ipc/socket-client.js';

const TOKEN = `sk-ant-oat01-${'Q'.repeat(90)}`;

const running: RunningDaemon[] = [];
const clients: SocketClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const d of running.splice(0)) await d.stop();
  clearDaemonInfo();
  releaseLock();
});

function capture(): Io & { readonly all: () => string } {
  let all = '';
  return { out: (t) => void (all += t), err: (t) => void (all += t), all: () => all };
}

/** Answers in order; every question asked is counted (and one not expected fails the test). */
function scripted(answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = (q: string): string => {
    asked.push(q);
    const a = answers.shift();
    if (a === undefined) throw new Error(`Not expected to ask: ${q}`);
    if (a === '^C') throw new Cancelled();
    return a;
  };
  return { asked, ask: async (q, fallback) => next(q) || (fallback ?? ''), confirm: async (q, fallback) => yesNo(next(q), fallback), secret: async (q) => next(q) };
}

/** A phone that dials in as soon as pairing opens. */
function fakePhone(): PairLink {
  const store = new Store(initialState('room'));
  const set = (c: object): void => store.dispatch({ type: 'companion', companion: { ...store.getState().companion, ...c } as never });
  return {
    start: async () => {
      const info = { link: 'beluga://device#abcdefghijklmnopqrstuvwxyz0123456789', code: 'K7QM-4XPA-R2TD', expiresAt: Date.now() + 600_000 };
      set({ pairing: info });
      setTimeout(() => set({ pairing: { ...info, waiting: { name: 'Pixel 9', fingerprint: '🐙 🌵 🎈 🦊' } } }), 20);
      return info;
    },
    approve: async () => set({ pairing: undefined, devices: [{ id: 'aaaaaaaaaaaaaaaa', name: 'Pixel 9', platform: 'android', pairedAt: Date.now(), linked: true, push: false } as DeviceView] }),
    cancel: async () => set({ pairing: undefined }),
    companion: () => store.getState().companion,
    onChange: (l) => store.subscribe(l),
  };
}

function repo(): string {
  const dir = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-setup-'))), 'notes');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first'], { cwd: dir });
  return dir;
}

/** Setup's world: a daemon in this process, a fake Claude, a fake service manager. */
function world(opts: { prompt: Prompter; signedIn?: boolean; setupToken?: number; env?: NodeJS.ProcessEnv; phone?: PairLink; enter?: boolean }) {
  // A fresh box: no projects, and none found in this Mac's own ~/Projects.
  writeFileSync(path.join(process.env.BELUGA_HOME!, 'projects.json'), JSON.stringify({ roots: [] }));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-setup-world-'));
  const state = { name: undefined as string | undefined, serviceInstalled: false, starts: 0, restarts: 0, setupTokens: 0 };
  const deps: SetupDeps = {
    prompt: opts.prompt,
    untilEnter: () => (opts.enter ? new Promise((r) => setTimeout(r, 50)) : new Promise(() => undefined)),
    claude: { signedIn: async () => opts.signedIn ?? false, setupToken: async () => (state.setupTokens++, opts.setupToken ?? 0) },
    name: { saved: () => state.name, fallback: () => 'homelab', save: (n) => void (state.name = n) },
    daemon: {
      running: () => Boolean(runningDaemon()),
      start: async (restart) => {
        if (restart) {
          state.restarts++;
          for (const d of running.splice(0)) await d.stop();
        }
        state.starts++;
        running.push(await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true }));
        return true;
      },
      attach: async () => {
        const client = await attach(readDaemonInfo()!);
        clients.push(client);
        return { projects: projectLinkOf(client), pair: opts.phone ?? pairLinkOf(client), close: () => client.close() };
      },
    },
    service: { installed: () => state.serviceInstalled, install: async (io: Io): Promise<Exit> => ((state.serviceInstalled = true), io.out('(service installed)\n'), 0) },
    env: opts.env ?? {},
    tokenFile: path.join(dir, 'claude-token'),
    tty: false,
    columns: 80,
  };
  return { deps, state };
}

describe('beluga setup', () => {
  it('sets up a fresh box in at most five answers: Claude, a name, a project, the phone, keeping it running', async () => {
    const project = repo();
    const prompt = scripted([TOKEN, '', project, 'y', '']);
    const env: NodeJS.ProcessEnv = {};
    const { deps, state } = world({ prompt, env, phone: fakePhone() });
    const io = capture();
    expect(await setup(deps, { yes: false }, io)).toBe(0);
    expect(prompt.asked).toHaveLength(5);
    expect(prompt.asked).toEqual([expect.stringContaining('Paste the token'), 'What should your phone call this computer?', expect.stringContaining('A first project'), 'Pair? [y/N] ', 'Keep Beluga running, and start it when this computer does?']);

    // Claude's token: kept 0600 for the daemon, never shown.
    expect(state.setupTokens).toBe(1);
    expect(readClaudeToken(deps.tokenFile)).toBe(TOKEN);
    if (process.platform !== 'win32') expect(statSync(deps.tokenFile!).mode & 0o777).toBe(0o600);
    expect(io.all()).not.toContain(TOKEN);
    expect(io.all()).not.toContain('QQQQQQQQ');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);

    expect(state.name).toBe('homelab');
    expect(io.all()).toContain('Added notes');
    expect(io.all()).toContain('“Pixel 9” wants to pair');
    expect(io.all()).toContain('Paired with Pixel 9');
    expect(state.serviceInstalled).toBe(true);
    expect(io.all()).toContain('All set.');
  });

  it('run again, says what is done and asks nothing', async () => {
    const project = repo();
    const first = world({ prompt: scripted([TOKEN, 'nas', project, 'y', 'y']), phone: fakePhone() });
    await setup(first.deps, { yes: false }, capture());
    const io = capture();
    const again: SetupDeps = { ...first.deps, prompt: scripted([]) };
    // The same daemon and phone: everything is there now.
    expect(await setup(again, { yes: false }, io)).toBe(0);
    expect(io.all()).toContain('Claude is signed in (its token is kept for Beluga)');
    expect(io.all()).toContain('Your phone calls this computer “nas”');
    expect(io.all()).toContain('✓ Projects: notes.');
    expect(io.all()).toContain('Paired: Pixel 9');
    expect(io.all()).toContain('It keeps running');
    expect(first.state.setupTokens).toBe(1);
  });

  it('--yes takes every default and asks nothing: a token from the environment, the host name, the service', async () => {
    const project = repo();
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
    const { deps, state } = world({ prompt: scripted([]), env });
    const io = capture();
    expect(await setup(deps, { yes: true, project }, io)).toBe(0);
    expect(readClaudeToken(deps.tokenFile)).toBe(TOKEN);
    expect(io.all()).not.toContain(TOKEN);
    expect(state.name).toBe('homelab');
    expect(io.all()).toContain('Added notes');
    expect(state.serviceInstalled).toBe(true);
    expect(io.all()).toContain('Still to do:\n  - pair your phone: `beluga pair`');
  });

  it('--yes without any way to sign Claude in says how, and goes on', async () => {
    const { deps, state } = world({ prompt: scripted([]) });
    const io = capture();
    expect(await setup(deps, { yes: true }, io)).toBe(0);
    expect(state.setupTokens).toBe(0);
    expect(io.all()).toContain('sign in to Claude: `beluga setup`');
    expect(io.all()).toContain('add a project');
  });

  it('already signed in, it doesn’t ask; a changed name restarts the running Beluga', async () => {
    const { deps, state } = world({ prompt: scripted(['studio', '', 'n']), signedIn: true, enter: true });
    await deps.daemon.start(false);
    const io = capture();
    expect(await setup(deps, { yes: false }, io)).toBe(0);
    expect(state.setupTokens).toBe(0);
    expect(io.all()).toContain('Claude is signed in.');
    expect(state.restarts).toBe(1);
    expect(io.all()).toContain('Beluga restarted with that.');
    // Enter skipped the phone; no service.
    expect(io.all()).toContain('Pairing cancelled');
    expect(io.all()).toContain('pair your phone: `beluga pair`');
    expect(io.all()).toContain('keep it running: `beluga service install`');
  });

  it('a pasted line that isn’t a token is caught, not kept', async () => {
    const { deps } = world({ prompt: scripted(['hello', '', '', 'n']), enter: true });
    const io = capture();
    expect(await setup(deps, { yes: false }, io)).toBe(0);
    expect(readClaudeToken(deps.tokenFile)).toBeUndefined();
    expect(io.all()).toContain('doesn’t look like a Claude token');
  });

  it('Ctrl+C stops it, to pick up later', async () => {
    const { deps } = world({ prompt: scripted(['^C']), setupToken: 0 });
    const io = capture();
    expect(await setup(deps, { yes: false }, io)).toBe(130);
    expect(io.all()).toContain('picks up where you left off');
  });
});

describe('Claude’s token for the daemon', () => {
  it('goes into the daemon’s environment, unless one is set', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-token-')), 'claude-token');
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = {};
    expect(useClaudeToken(env, file)).toBe(true);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    const own: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-mine' };
    expect(useClaudeToken(own, file)).toBe(false);
    expect(own.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-mine');
    expect(looksLikeToken('sk-ant-oat01-short')).toBe(false);
    expect(looksLikeToken(` ${TOKEN}\n`)).toBe(true);
  });
});
