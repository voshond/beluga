// A few unit-test runs at a time, machine-wide: ten worktrees running `npm test` at once leave the Mac usable.
// vitest.config.ts uses this file as its global setup, so every vitest run (npm test, npx vitest …) takes
// one of KLAUD_TEST_SLOTS slots (default 2) before its workers start, waits while they're all taken
// ("waiting for a unit-test slot: KLD-12, KLD-14 are running"), and gives it back when it ends. A run
// killed outright leaves a slot whose owner is dead: the next run takes it over.
// The slots live in ~/.klaud/tests (KLAUD_TEST_DIR overrides it). KLAUD_TEST_SLOTS=0 turns the limit off.
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alive, runName, worktreeOf } from './e2e-lock.mjs';

/** Where the slots are kept. */
export const slotsDir = () => process.env.KLAUD_TEST_DIR || path.join(os.homedir(), '.klaud', 'tests');

/** How many unit-test runs may go at once (KLAUD_TEST_SLOTS; 0 = no limit). */
export function slotCount(env = process.env) {
  const n = Number.parseInt(env.KLAUD_TEST_SLOTS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

/** vitest workers per run: KLAUD_TEST_WORKERS, else every core on CI (the runner is the run's alone), else half the cores (at least 2). */
export function workerCount(env = process.env, cores = os.availableParallelism()) {
  const n = Number.parseInt(env.KLAUD_TEST_WORKERS ?? '', 10);
  if (Number.isFinite(n) && n > 0) return n;
  return env.CI ? Math.max(2, cores) : Math.max(2, Math.floor(cores / 2));
}

function readSlot(file) {
  try {
    const slot = JSON.parse(readFileSync(file, 'utf8'));
    return typeof slot?.pid === 'number' ? slot : undefined;
  } catch {
    return undefined;
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Take a free slot for this run, or say who holds them all. A slot whose owner died is taken over.
 * → { ok: true, file } | { ok: false, holders }
 */
export function trySlot(run, { dir = slotsDir(), slots = slotCount() } = {}) {
  mkdirSync(dir, { recursive: true });
  const holders = [];
  for (let i = 0; i < slots; i++) {
    const file = path.join(dir, `slot-${i}.json`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(file, 'wx', 0o600);
        writeSync(fd, JSON.stringify(run));
        closeSync(fd);
        return { ok: true, file };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const holder = readSlot(file);
        if (holder?.pid === run.pid) return { ok: true, file };
        // Unreadable and new: another run is writing it right now.
        if (!holder && Date.now() - mtimeOf(file) < 5000) {
          holders.push({ pid: 0, name: 'another run', startedAt: Date.now() });
          break;
        }
        if (holder && alive(holder.pid)) {
          holders.push(holder);
          break;
        }
        rmSync(file, { force: true });
      }
    }
  }
  return { ok: false, holders };
}

/** Give a slot back (only if it's still this run's). */
export function releaseSlot(file, pid = process.pid) {
  if (readSlot(file)?.pid === pid) rmSync(file, { force: true });
}

/** What a waiting run prints. */
export const waitingLine = (holders, slots) =>
  `waiting for a unit-test slot: ${[...new Set(holders.map((h) => h.name))].join(', ')} ${holders.length === 1 ? 'is' : 'are'} running (${slots} at a time; KLAUD_TEST_SLOTS changes it)`;

/** Wait for a slot (polling), saying who we wait for when that changes. Gives up after `maxMs` (→ undefined). */
export async function waitForSlot(run, { dir = slotsDir(), slots = slotCount(), log = console.log, pollMs = 500, maxMs = 30 * 60_000 } = {}) {
  const start = Date.now();
  let said = '';
  for (;;) {
    const got = trySlot(run, { dir, slots });
    if (got.ok) return got.file;
    const line = waitingLine(got.holders, slots);
    if (line !== said) log(line);
    said = line;
    if (Date.now() - start > maxMs) return undefined;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function branchOf(dir) {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** vitest's global setup: hold a slot for the whole run. */
export default async function setup() {
  const slots = slotCount();
  // A run started from inside a run (a test that runs vitest) already has its slot.
  if (!slots || process.env.KLAUD_TEST_SLOT) return undefined;
  const worktree = worktreeOf(process.cwd());
  const run = { pid: process.pid, name: runName(worktree, branchOf(worktree)), worktree, startedAt: Date.now() };
  const file = await waitForSlot(run, { slots });
  if (!file) {
    console.log('Waited 30 minutes for a unit-test slot: running anyway.');
    return undefined;
  }
  process.env.KLAUD_TEST_SLOT = file;
  const release = () => releaseSlot(file);
  process.once('exit', release);
  return () => {
    process.off('exit', release);
    release();
    delete process.env.KLAUD_TEST_SLOT;
  };
}
