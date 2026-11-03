// When every test passes on a Mac, say so in a line for the commit message: "Tested-on: macOS <tree>".
// <tree> is git's id for exactly the files that were tested (committed or not), so CI's macOS run
// (.github/workflows/ci.yml) skips itself for a commit that carries the line and has that tree: the
// same files already passed on a Mac. Change any file after the run and the ids differ: CI tests it.
// Linux and Windows always run on CI. vitest.config.ts uses this file as a reporter.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TRAILER = 'Tested-on: macOS';

/** The line for a commit whose files are `tree`. */
export const trailerFor = (tree) => `${TRAILER} ${tree}`;

/** git's tree id for the folder as it is now (untracked files too, ignored ones not); undefined outside git. */
export function workingTree(cwd = process.cwd()) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'beluga-tree-'));
  // A copy of the real index: git add reads its stat cache (fast) and the real one is left alone.
  const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
  const git = (args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    try {
      copyFileSync(path.resolve(cwd, git(['rev-parse', '--git-path', 'index'])), env.GIT_INDEX_FILE);
    } catch {
      // No index yet: git add builds one.
    }
    git(['add', '-A']);
    return git(['write-tree']) || undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** How many test files the whole suite has (vitest.config.ts: tests/**\/*.test.ts). */
export const suiteSize = (dir = 'tests') => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.test.ts')).length;

/** Whether a finished run counts: the whole suite (no file, name or shard filter), all passed. */
export const wholeSuitePassed = ({ reason, errors, modules, suite, namePattern }) =>
  reason === 'passed' && errors === 0 && !namePattern && modules === suite;

export default class LocalPass {
  onInit(vitest) {
    this.vitest = vitest;
    // Only a Mac's own run: CI's runs prove nothing to CI.
    this.tree = process.platform === 'darwin' && !process.env.CI ? workingTree(vitest.config.root) : undefined;
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    if (!this.tree) return;
    const { root, testNamePattern } = this.vitest.config;
    const passed = wholeSuitePassed({
      reason,
      errors: unhandledErrors.length,
      modules: testModules.length,
      suite: suiteSize(path.join(root, 'tests')),
      namePattern: testNamePattern,
    });
    // A file changed while the tests ran: these aren't the files that passed.
    if (!passed || workingTree(root) !== this.tree) return;
    console.log(`\nEvery test passed on this Mac for exactly these files. End the commit message with this line and CI skips its macOS run:\n${trailerFor(this.tree)}\n`);
  }
}
