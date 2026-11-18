import fs, { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// GitHub's Windows runners name the temp folder the short 8.3 way (C:\Users\RUNNER~1\…), while git
// and Beluga see it by its long name: use the long one, so the folders the tests make match.
if (process.platform === 'win32') process.env.TEMP = process.env.TMP = realpathSync.native(os.tmpdir());
// A shell or git that just ended still holds its folder for a moment on Windows, and anywhere a write
// still landing can refill a folder being removed (ENOTEMPTY): a test's cleanup tries again rather
// than failing the test it follows.
const rm = fs.rmSync;
fs.rmSync = ((p, o) => rm(p, o?.recursive ? { maxRetries: 10, retryDelay: 100, ...o } : o)) as typeof fs.rmSync;
syncBuiltinESMExports();

// Nor the developer's own Beluga settings: a shell an agent of a running daemon opened carries the
// daemon's environment (BELUGA_PREVIEW_ORIGIN and the like, from its service), and a test would see
// this machine's setup instead of the defaults it asserts. Every test starts from none; one that
// needs a variable sets it. KLAUD_TEST_SLOT is this run's own (scripts/test-lock.mjs), kept.
const OWN_SETTING = /^(BELUGA|KLAUDE?)_/;
for (const name of Object.keys(process.env)) {
  if (OWN_SETTING.test(name) && name !== 'KLAUD_TEST_SLOT') delete process.env[name];
}
// Nor where the developer points Claude Code, Codex, Copilot, gh or XDG data: the test home's own.
for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_ENV_FILE', 'COPILOT_HOME', 'GH_CONFIG_DIR', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
  delete process.env[name];
}

// Never read or write the developer's real ~/.beluga (or an old ~/.klaud) during tests.
// Workspace discovery and other tools also use the OS home directly. Without this, a fresh
// WorkspaceStore scans the developer's real Projects/Repos folders, and git uses their signing
// agent: a populated home makes unrelated tests time out (and exposes real data to fixtures).
// Every home a test file gets sits in one folder, removed once the file's tests are done, so a run
// doesn't leave a folder per test file behind.
const homes = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-test-')));
const made = (name: string): string => {
  const dir = path.join(homes, name);
  mkdirSync(dir);
  return dir;
};
const home = made('os-home');
process.env.HOME = home;
if (process.platform === 'win32') process.env.USERPROFILE = home;
// Git also reads $XDG_CONFIG_HOME/git/config, wherever the developer points it: give git (and
// anything else reading XDG) the test home's own, empty, config.
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
mkdirSync(process.env.XDG_CONFIG_HOME);
writeFileSync(path.join(home, '.zshrc'), '');
process.env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig');
// The tests read files byte for byte: without this, Git for Windows' own config (autocrlf=true)
// checks every file out with CRLF. Harmless elsewhere, where it's already off.
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[core]\n\tautocrlf = false\n');
process.env.BELUGA_HOME = made('beluga-home');
// Nor the developer's Codex sessions (deleting a worktree forgets the ones that ran there).
process.env.CODEX_HOME = made('codex-home');

// Hooks run last-registered first, so this comes after each file's own cleanup. A process still
// holding a folder (Windows) only leaves it behind: never fail the file for it.
afterAll(() => {
  try {
    fs.rmSync(homes, { recursive: true, force: true });
  } catch {
    // Left in the temp folder; the OS clears it.
  }
});

// A whole suite keeps every core and the disk busy, and macOS then holds a lowest-priority delete
// back for tens of seconds: tests that wait for one (deletesSettled) delete at normal priority.
process.env.BELUGA_DELETE_PRIORITY ??= 'normal';

// The tests are a Mac's wherever they run ("Your Mac"; shared/assistant.ts).
process.env.BELUGA_COMPUTER ??= 'mac';
