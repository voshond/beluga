import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { claudeCodeCommand, claudeCodeReady } from '../agent/claude-code.js';
import { claudeStatus } from '../agent/runtime/claude/status.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { runningDaemon } from '../daemon/files.js';
import { attach } from './attach.js';
import { runSetupToken } from './claude.js';
import type { Exit, Io } from './io.js';
import { upDeps } from './main.js';
import { pairLinkOf } from './pair.js';
import { projectLinkOf } from './project.js';
import { terminalPrompter, untilEnter } from './prompt.js';
import { installService, serviceEnv, serviceInstalled } from './service.js';
import { type SetupDeps, type SetupOptions, setup } from './setup.js';
import { stop } from './stop.js';
import { up } from './up.js';

/** This computer's own name: a Mac's Sharing name, else its host name. */
function ownName(): string {
  try {
    if (process.platform === 'darwin') {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2_000 }).trim();
      if (name) return name;
    }
  } catch {
    // the host name will do
  }
  return os.hostname().replace(/\.local$/, '') || 'my server';
}

const quiet: Io = { out: () => undefined, err: () => undefined };

/** `beluga setup` on this computer, with this terminal's questions. */
export async function setupHere(opts: SetupOptions, io: Io): Promise<Exit> {
  const svc = serviceEnv();
  const deps: SetupDeps = {
    prompt: terminalPrompter(),
    untilEnter: (signal) => untilEnter(signal),
    claude: {
      signedIn: async () => (await claudeStatus()).state === 'ready',
      setupToken: async () => {
        // The server install brings Claude Code's pinned binary on first use: fetched here, with its progress.
        let shown = -1;
        await claudeCodeReady(({ got, total }) => {
          const pct = total ? Math.floor((got / total) * 100) : -1;
          if (pct >= 0 && pct !== shown && pct % 10 === 0) io.err(`Downloading Claude Code… ${(shown = pct)}%\n`);
        });
        return runSetupToken(claudeCodeCommand());
      },
    },
    name: {
      saved: () => loadSettings().computerName,
      fallback: ownName,
      save: (computerName) => void saveSettings({ computerName }),
    },
    daemon: {
      running: () => Boolean(runningDaemon()),
      start: async (restart) => {
        if (restart) await stop(quiet);
        return (await up({}, { out: () => undefined, err: io.err }, await upDeps())) === 0;
      },
      attach: async () => {
        const info = runningDaemon();
        if (!info) throw new Error('Beluga stopped');
        const client = await attach(info);
        return { projects: projectLinkOf(client), pair: pairLinkOf(client), close: () => client.close() };
      },
    },
    service: { installed: () => serviceInstalled(svc), install: (out) => installService(svc, out) },
    tty: Boolean(process.stdout.isTTY),
    columns: process.stdout.columns ?? 80,
  };
  return setup(deps, opts, io);
}
