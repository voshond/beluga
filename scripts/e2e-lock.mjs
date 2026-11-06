#!/usr/bin/env node
// One Mac e2e run at a time, machine-wide, and nothing left behind when it ends.
//   node scripts/e2e-lock.mjs <command…>        (packages/mac's `npm run e2e` runs playwright through it)
// - A second run, from any worktree, waits for the first and says whose it is ("waiting for KLD-12's e2e").
// - Each worktree gets its own E2E_PORT and demo home (BELUGA_HOME), so runs never share a server or a daemon.
//   Each playwright worker starts its own demo daemons next to it (see slotHomes and e2e/fixtures.ts).
// - The command runs in its own process group; every process it starts is tracked (even ones that move to
//   their own group, like vite and the browser) and stopped however the run ends: done, Ctrl-C, killed.
// - A run that fails while the Mac is overloaded re-runs its failed tests once, alone, after the load drops.
// The lock lives in ~/.beluga/e2e (BELUGA_E2E_DIR overrides it); Beluga reads it to stop a worktree's tests.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** BELUGA_<name>, else the KLAUD_<name> from before the rename. */
const belugaEnv = (name) => process.env[`BELUGA_${name}`] ?? process.env[`KLAUD_${name}`];

/** Where the machine-wide lock is kept: ~/.beluga/e2e (the old ~/.klaud/e2e while only that home exists). */
export function stateDir() {
  const fromEnv = belugaEnv('E2E_DIR');
  if (fromEnv) return fromEnv;
  const [beluga, klaud] = ['.beluga', '.klaud'].map((name) => path.join(os.homedir(), name));
  return path.join(!existsSync(beluga) && existsSync(klaud) ? klaud : beluga, 'e2e');
}
export const lockFile = () => path.join(stateDir(), 'lock.json');

const short = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);

/** The worktree a folder is in (its git top level), else the folder. */
export function worktreeOf(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || dir;
  } catch {
    return dir;
  }
}

/** Whose run it is, in words: "KLD-12" from a task branch (beluga/kld-12-…), else the worktree's name. */
export function runName(worktree, branch) {
  const key = /(?:^|\/)([a-z]{2,6})-(\d+)(?:-|$)/i.exec(branch ?? '');
  return key ? `${key[1].toUpperCase()}-${key[2]}` : path.basename(worktree);
}

function branchOf(dir) {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** A worktree's own vite port: stable for the worktree, different between worktrees (14300–17299). */
export const portFor = (worktree) => 14300 + (Number.parseInt(short(worktree), 16) % 3000);

/** A worktree's own demo home (Beluga's data) and pretend ~/.claude, in the temp folder (short paths). */
export function homesFor(worktree) {
  const base = path.join(os.tmpdir(), `beluga-e2e-${short(worktree)}`);
  return { home: path.join(base, 'home'), claude: path.join(base, 'claude') };
}

/**
 * One of a run's demo homes: playwright worker `worker` keeps two (slot 0 in use, slot 1 warming up for
 * the next spec file, then they swap), next to the run's home: home-2b, claude-2b.
 */
export const slotHomes = ({ home, claude }, worker, slot) => ({ home: `${home}-${worker}${'ab'[slot]}`, claude: `${claude}-${worker}${'ab'[slot]}` });

/**
 * How many playwright workers a run uses: E2E_WORKERS, else one per 2 idle cores, up to 3 (fewer on a
 * small Mac, 1 on one with next to nothing idle). Most of a run is waiting on the demo, so 3 is fast enough.
 * `busy` is the share of the CPU in use (0–1): measured by the lock (busyShare), else guessed from the load.
 */
export function workerCount(env = process.env, cores = os.cpus().length, busy = Math.min(1, loadPerCore())) {
  const asked = Number.parseInt(env.E2E_WORKERS ?? '', 10);
  if (asked > 0) return asked;
  const idleCores = cores * (1 - Math.min(1, Math.max(0, busy)));
  return Math.max(1, Math.min(3, Math.floor(cores / 2), Math.round(idleCores / 2)));
}

/** Whether a process is alive (and ours to signal). */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function readLock(file = lockFile()) {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    return typeof lock?.pid === 'number' ? lock : undefined;
  } catch {
    return undefined;
  }
}

function writeLock(lock, file = lockFile()) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock, null, 2));
  renameSync(tmp, file);
}

/**
 * Take the lock for this run, or say who has it. A lock whose owner died is taken over (after
 * `onStale` cleans up what that run left running).
 * → { ok: true } | { ok: false, holder }
 */
export function tryLock(run, { file = lockFile(), onStale } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, JSON.stringify(run, null, 2));
      closeSync(fd);
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = readLock(file);
      // Unreadable and new: another run is writing it right now.
      if (!holder && Date.now() - mtimeOf(file) < 5000) return { ok: false, holder: { pid: 0, name: 'another run', startedAt: Date.now() } };
      if (holder && holder.pid !== run.pid && alive(holder.pid)) return { ok: false, holder };
      if (holder && holder.pid === run.pid) return { ok: true };
      if (holder) onStale?.(holder);
      rmSync(file, { force: true });
    }
  }
  const holder = readLock(file);
  return holder ? { ok: false, holder } : { ok: false, holder: { pid: 0, name: 'another run', startedAt: Date.now() } };
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function releaseLock(pid = process.pid, file = lockFile()) {
  if (readLock(file)?.pid === pid) rmSync(file, { force: true });
}

const ago = (ms) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`);

/** What a waiting run prints. */
export const waitingLine = (holder, now = Date.now()) =>
  `waiting for ${holder.name}'s e2e (started ${ago(now - holder.startedAt)} ago${holder.worktree ? ` in ${path.basename(holder.worktree)}` : ''}, pid ${holder.pid}): one Mac e2e run at a time`;

/** Wait for the lock (polling), printing who we wait for now and then. Gives up after `maxMs`. */
export async function waitForLock(run, { file = lockFile(), onStale, log = console.log, pollMs = 2000, sayEveryMs = 60_000, maxMs = 60 * 60_000 } = {}) {
  const start = Date.now();
  let said = 0;
  let saidPid = 0;
  for (;;) {
    const got = tryLock(run, { file, onStale });
    if (got.ok) return true;
    if (got.holder.pid !== saidPid || Date.now() - said >= sayEveryMs) {
      log(waitingLine(got.holder));
      said = Date.now();
      saidPid = got.holder.pid;
    }
    if (Date.now() - start > maxMs) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ------------------------------------------------------------------ processes

/** Every process: pid, parent and group (one `ps`). */
export function processTable() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((r) => r.length === 3 && r.every(Number.isFinite))
      .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
  } catch {
    return [];
  }
}

/** The process groups of `root` and everything under it (some children start their own group). */
export function groupsUnder(root, table) {
  const kids = new Map();
  for (const p of table) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const groups = new Set();
  const seen = new Set([root]);
  const queue = [root];
  const self = table.find((p) => p.pid === root);
  if (self) groups.add(self.pgid);
  while (queue.length) {
    for (const k of kids.get(queue.shift()) ?? []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      groups.add(k.pgid);
      queue.push(k.pid);
    }
  }
  return groups;
}

/** Processes whose environment carries `KEY=value` (ps -E: only the user's own processes). */
export function processesTagged(key, value) {
  const needle = ` ${key}=${value}`;
  try {
    return execFileSync('ps', ['-axwwE', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      .split('\n')
      .filter((l) => l.includes(needle) && (l.includes(`${needle} `) || l.endsWith(needle)))
      .map((l) => l.trim().split(/\s+/).slice(0, 2).map(Number))
      .filter(([pid, pgid]) => Number.isFinite(pid) && Number.isFinite(pgid))
      .map(([pid, pgid]) => ({ pid, pgid }));
  } catch {
    return [];
  }
}

const lsofListeners = (port) =>
  execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .map(Number)
    .filter((n) => n > 0);

const ssListeners = (port) =>
  [...execFileSync('ss', ['-Hltnp', `sport = :${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));

/** Who listens on a TCP port (pids): lsof, or ss where there's none (a bare Linux). */
export function listeners(port) {
  try {
    return lsofListeners(port);
  } catch {
    try {
      return [...new Set(ssListeners(port))];
    } catch {
      return [];
    }
  }
}

/** A command line, for saying who holds a port ("node …/vite --port 14321"). */
function commandOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 160);
  } catch {
    return '';
  }
}

/**
 * Why the run's port can't be used, or undefined when it's free. Checked before playwright starts:
 * playwright starts its web server (vite, on this port) before the global setup runs.
 */
export function portProblem(port) {
  const pids = listeners(port);
  if (!pids.length) return undefined;
  return `Port ${port} is in use by ${pids.map((p) => `pid ${p}${commandOf(p) ? ` (${commandOf(p)})` : ''}`).join(', ')}. Stop it, or set E2E_PORT to another port.`;
}

const signal = (target, sig) => {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stop process groups (and single pids): SIGTERM, then SIGKILL what's still there after `graceMs`.
 * Never this process's own group.
 */
export async function stopGroups({ groups = [], pids = [] }, { graceMs = 3000 } = {}) {
  const own = processTable().find((p) => p.pid === process.pid)?.pgid;
  const gs = [...new Set(groups)].filter((g) => g > 1 && g !== own);
  const ps = [...new Set(pids)].filter((p) => p > 1 && p !== process.pid);
  for (const g of gs) signal(-g, 'SIGTERM');
  for (const p of ps) signal(p, 'SIGTERM');
  const left = () => gs.some((g) => signal(-g, 0)) || ps.some((p) => alive(p));
  for (let t = 0; t < graceMs && left(); t += 100) await new Promise((r) => setTimeout(r, 100));
  for (const g of gs) signal(-g, 'SIGKILL');
  for (const p of ps) signal(p, 'SIGKILL');
}

/** Every process with its command line and (ps -E) environment: yours only. */
function psEnv() {
  try {
    return execFileSync('ps', ['-axwwE', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      .split('\n')
      .map((l) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), line: m[3] }));
  } catch {
    return [];
  }
}

/**
 * The processes a run can verify are its own: their environment carries its run tag
 * (BELUGA_E2E_RUN=<id>, or KLAUD_E2E_RUN from before the rename) and their command line or working folder is under its worktree. A pid
 * reused after a reboot can't have both, so nothing else is ever matched.
 */
export function processesOf(run, rows = psEnv()) {
  if (!run?.id || !run.worktree) return [];
  const tags = [` BELUGA_E2E_RUN=${run.id}`, ` KLAUD_E2E_RUN=${run.id}`];
  const under = new RegExp(`${run.worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|\\s|$)`);
  const tagged = (line) => tags.some((tag) => line.includes(`${tag} `) || line.endsWith(tag));
  return rows.filter((r) => r.pid !== process.pid && tagged(r.line) && under.test(r.line)).map(({ pid, pgid }) => ({ pid, pgid }));
}

/**
 * Stop everything a run started: only the processes it can verify are its own (see processesOf),
 * one by one. Never a stored pid or process group, the demo daemon's pid file, or whoever listens
 * on its port alone: after a reboot or pid reuse those can be anyone's.
 */
export async function stopRun(run, opts) {
  await stopGroups({ pids: processesOf(run).map((p) => p.pid) }, opts);
}

// ------------------------------------------------------------------ load

/** The 1-minute load per core (1 = every core busy). */
export const loadPerCore = () => os.loadavg()[0] / Math.max(1, os.cpus().length);

/**
 * The share of the CPU actually in use (0–1) over `ms`. Not the load average: on a Mac that counts
 * threads waiting on disk and the like, and reads 1–2× the cores while a third of the CPU sits idle.
 */
export async function busyShare(ms = 1000) {
  const ticks = () => os.cpus().map((c) => ({ idle: c.times.idle, all: Object.values(c.times).reduce((a, b) => a + b, 0) }));
  const before = ticks();
  await new Promise((r) => setTimeout(r, ms));
  const after = ticks();
  let idle = 0;
  let all = 0;
  after.forEach((c, i) => {
    idle += c.idle - (before[i]?.idle ?? c.idle);
    all += c.all - (before[i]?.all ?? c.all);
  });
  return all > 0 ? 1 - idle / all : 0;
}

/** CPU seconds from ps's time column ("1:02.50", "1:01:02.50", "2-01:01:02"). */
export function cpuSeconds(time) {
  const [days, rest] = time.includes('-') ? time.split('-') : ['0', time];
  return Number(days) * 86400 + rest.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

/** Every process: pid, parent, CPU seconds used so far, memory (bytes) and its program's name. */
function usageTable() {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,time=,rss=,comm='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n')
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(l))
      .filter(Boolean)
      .map(([, pid, ppid, time, rss, comm]) => ({ pid: Number(pid), ppid: Number(ppid), cpu: cpuSeconds(time), bytes: Number(rss) * 1024, name: path.basename(comm.trim()) }))
      .filter((r) => Number.isFinite(r.pid) && Number.isFinite(r.cpu) && Number.isFinite(r.bytes));
  } catch {
    return [];
  }
}

/** The pids under `root` (it included), by parent. */
export function pidsUnder(root, table) {
  const kids = new Map();
  for (const p of table) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) for (const k of kids.get(queue.shift()) ?? []) if (!seen.has(k)) seen.add(k), queue.push(k);
  return seen;
}

/**
 * What a run costs the Mac, sampled now and then: CPU in cores (from the CPU time its processes used
 * between two samples) and memory (their resident memory; shared pages count once per process, so it
 * errs high). `sample(pids)` takes the run's processes: everything under it, and what carries its tag.
 */
export function usageMeter() {
  let last;
  const peak = { cores: 0, bytes: 0, busiest: [] };
  return {
    peak,
    sample(pids, table = usageTable(), now = Date.now()) {
      const mine = table.filter((r) => pids.has(r.pid));
      const cpu = new Map(mine.map((r) => [r.pid, r.cpu]));
      const bytes = mine.reduce((sum, r) => sum + r.bytes, 0);
      peak.bytes = Math.max(peak.bytes, bytes);
      if (last && now > last.at) {
        // A process new since the last sample used all its CPU time in between.
        const secs = (now - last.at) / 1000;
        const each = mine.map((r) => ({ name: r.name ?? String(r.pid), cores: Math.max(0, r.cpu - (last.cpu.get(r.pid) ?? 0)) / secs }));
        const cores = each.reduce((sum, p) => sum + p.cores, 0);
        if (cores > peak.cores) {
          peak.cores = cores;
          // What was busy then, by program: for finding what to make lighter.
          const by = new Map();
          for (const p of each) by.set(p.name, (by.get(p.name) ?? 0) + p.cores);
          peak.busiest = [...by].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, c]) => `${name} ${c.toFixed(1)}`);
        }
      }
      last = { at: now, cpu };
    },
  };
}

/** What a run cost, in words. */
export const usageLine = (peak, wallMs, cores = os.cpus().length) =>
  `e2e took ${(wallMs / 60_000).toFixed(1)} min; at most ${peak.cores.toFixed(1)} of ${cores} cores and ${(peak.bytes / 1024 ** 3).toFixed(2)} GB of memory${peak.busiest?.length ? ` (busiest then: ${peak.busiest.join(', ')})` : ''}`;

/** A run counts as "under load" when the Mac had more work than cores at some point. */
export const OVERLOADED = 1.5;

/** The command again for just the tests that failed (playwright only), else undefined. */
export function rerunArgs(args) {
  if (!args.some((a) => /playwright/.test(a))) return undefined;
  return [...args.filter((a) => a !== '--last-failed'), '--last-failed'];
}

// ------------------------------------------------------------------ the run

/** The command running now (kept off `run`, which is written to the lock file). */
let current;

function runOnce(cmd, args, env, run, meter) {
  return new Promise((resolve) => {
    // At a lower priority (it and all it starts: vite, the browsers, the demo daemons): the Mac stays yours.
    const child = spawn('nice', ['-n', '10', cmd, ...args], { stdio: 'inherit', env, detached: true });
    current = child;
    run.groups = [child.pid];
    let peak = loadPerCore();
    let tick = 0;
    let tagged = [];
    const track = setInterval(() => {
      const before = run.groups.length;
      const table = processTable();
      run.groups = [...new Set([...run.groups, ...groupsUnder(child.pid, table)])];
      if (run.groups.length !== before) writeLock(run);
      peak = Math.max(peak, loadPerCore());
      // The demo daemons are started apart (npx, then their own group): found by the run's tag, now and then.
      if (tick++ % 4 === 0) tagged = processesOf(run).map((p) => p.pid);
      meter.sample(new Set([...pidsUnder(child.pid, table), ...tagged]));
    }, 2500);
    child.on('exit', (code, sig) => {
      clearInterval(track);
      current = undefined;
      resolve({ code: code ?? (sig ? 1 : 0), peak });
    });
  });
}

async function main(argv) {
  if (!argv.length) {
    console.error('usage: node scripts/e2e-lock.mjs <command…>');
    process.exit(2);
  }
  const worktree = worktreeOf(process.cwd());
  const homes = homesFor(worktree);
  const port = Number(process.env.E2E_PORT) || portFor(worktree);
  const run = {
    id: `${process.pid}-${Date.now().toString(36)}`,
    pid: process.pid,
    name: runName(worktree, branchOf(worktree)),
    worktree,
    port,
    // Never an inherited BELUGA_HOME (or KLAUD_HOME): inside Beluga that's your real data, and the demo home is wiped each run.
    home: belugaEnv('E2E_HOME') || homes.home,
    startedAt: Date.now(),
    groups: [],
  };
  const env = {
    ...process.env,
    E2E_PORT: String(port),
    // Both names: the daemon reads BELUGA_* first, and older readers (or an inherited BELUGA_HOME) must never win.
    BELUGA_HOME: run.home,
    KLAUD_HOME: run.home,
    BELUGA_CLAUDE_HOME: homes.claude,
    KLAUD_CLAUDE_HOME: homes.claude,
    BELUGA_E2E_RUN: run.id,
    KLAUD_E2E_RUN: run.id,
  };

  let ending = false;
  const finish = async (code) => {
    if (ending) return;
    ending = true;
    await stopRun(run);
    releaseLock(run.pid);
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      // Let playwright run its teardown first, then stop whatever is still there.
      if (!current) return void finish(130);
      signal(-current.pid, sig === 'SIGHUP' ? 'SIGTERM' : sig);
      current.once('exit', () => void finish(130));
      setTimeout(() => void finish(130), 8000).unref();
    });
  }

  let cleaned;
  const onStale = (old) => {
    if (old.id === cleaned) return;
    console.log(`${old.name}'s e2e (pid ${old.pid}) ended without cleaning up: stopping what it left running`);
    void stopRun(old, { graceMs: 1000 });
  };
  // A run that was killed outright: stop what it left before taking its place (and again in the race below).
  const before = readLock();
  if (before && !alive(before.pid)) {
    console.log(`${before.name}'s e2e (pid ${before.pid}) ended without cleaning up: stopping what it left running`);
    await stopRun(before, { graceMs: 1000 });
    cleaned = before.id;
  }
  const got = await waitForLock({ ...run, groups: [] }, { onStale });
  if (!got) {
    console.error('Gave up waiting for the e2e lock after an hour. If no e2e is really running, delete ' + lockFile());
    process.exit(1);
  }
  console.log(`e2e for ${run.name} on port ${port} (demo home ${run.home})`);
  const busy = portProblem(port);
  if (busy) {
    console.error(`The e2e can't start: ${busy}`);
    return void finish(1);
  }

  // How many workers, from how busy the CPU really is now (playwright.config.ts takes E2E_WORKERS as is).
  if (!(Number.parseInt(env.E2E_WORKERS ?? '', 10) > 0)) {
    const busy = await busyShare();
    env.E2E_WORKERS = String(workerCount({}, os.cpus().length, busy));
    console.log(`${env.E2E_WORKERS} worker${env.E2E_WORKERS === '1' ? '' : 's'}: ${Math.round(busy * 100)}% of the ${os.cpus().length} cores busy (E2E_WORKERS=3 to choose)`);
  }

  const [cmd, ...args] = argv;
  const meter = usageMeter();
  const began = Date.now();
  let { code, peak } = await runOnce(cmd, args, env, run, meter);
  console.log(usageLine(meter.peak, Date.now() - began));
  await stopRun(run, { graceMs: 1000 });
  const again = code !== 0 && peak > OVERLOADED ? rerunArgs(argv) : undefined;
  if (again) {
    console.log(`The run failed while the Mac was overloaded (load ${peak.toFixed(1)}× its ${os.cpus().length} cores). Re-running just the failed tests once, alone, when the load drops…`);
    for (let t = 0; t < 10 * 60_000 && loadPerCore() > 1; t += 5000) await new Promise((r) => setTimeout(r, 5000));
    ({ code } = await runOnce(again[0], again.slice(1), { ...env, E2E_WORKERS: '1' }, run, usageMeter()));
    console.log(code === 0 ? 'They pass when run alone: the failure was the load, not the code.' : 'They fail alone too: a real failure.');
  }
  await finish(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main(process.argv.slice(2));
