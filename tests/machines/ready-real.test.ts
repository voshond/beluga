import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type ReadyDeps, Readying, hostReadyDeps, userEnv } from '../../src/machines/ready.js';
import type { ReadyRun } from '../../src/machines/ready-model.js';

/**
 * Get Ready for real (BLG-842): this computer's own bash, git, nvm and npm, for a user with a fresh
 * home (no projects folder, no nvm). A project is cloned from a bare repo served over plain HTTP
 * here (no network for that), its .nvmrc names a Node this computer lacks, which is named and
 * installed only after install(), the user-level way (nvm, never sudo), then its setup runs.
 * Opt-in (it downloads nvm and Node): BELUGA_READY_REAL=1. scripts/linux-test.sh --ubuntu runs it in
 * a fresh Ubuntu container as a user without sudo; on a Mac it runs as is. Each run's steps and
 * commands go to .beluga/scratch/ready-real-<platform>.log.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const WANTED = '18';
const real = Boolean(process.env.BELUGA_READY_REAL);
const cleanup: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Beluga Test', '-c', 'user.email=test@beluga.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });

/** A bare repo with a small Node project in it, served read-only over git's plain HTTP. */
async function servedRepo(): Promise<{ origin: string; server: Server }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-ready-origin-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src');
  mkdirSync(src);
  git(src, 'init', '-q');
  writeFileSync(path.join(src, '.nvmrc'), `${WANTED}\n`);
  // One dependency, in the repo itself (file:), so setup installs something without the network.
  mkdirSync(path.join(src, 'vendor', 'greet'), { recursive: true });
  writeFileSync(path.join(src, 'vendor', 'greet', 'package.json'), JSON.stringify({ name: 'greet', version: '1.0.0', main: 'index.js' }));
  writeFileSync(path.join(src, 'vendor', 'greet', 'index.js'), 'module.exports = () => "hi";\n');
  writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'ready-demo', version: '1.0.0', private: true, dependencies: { greet: 'file:vendor/greet' } }, null, 2));
  execFileSync('npm', ['install', '--package-lock-only', '--offline', '--no-audit', '--no-fund'], { cwd: src, env: userEnv(process.env, os.homedir()), stdio: 'ignore' });
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'A small Node project');
  const bare = path.join(dir, 'served');
  mkdirSync(bare);
  git(bare, 'clone', '-q', '--bare', src, 'ready-demo.git');
  git(path.join(bare, 'ready-demo.git'), 'update-server-info');
  const server = createServer((req, res) => {
    const file = path.join(bare, decodeURIComponent((req.url ?? '/').split('?')[0]!));
    if (!file.startsWith(bare) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200);
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}/ready-demo.git`, server };
}

describe.skipIf(!real)('Get Ready on this computer, for real', () => {
  it(
    'makes the projects folder, clones, names the missing Node, installs it only after install(), and runs setup',
    async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-ready-home-'));
      cleanup.push(() => rmSync(home, { recursive: true, force: true }));
      const { origin } = await servedRepo();
      const host = hostReadyDeps(home);
      const ran: string[] = [];
      const log: string[] = [`${os.platform()} ${os.release()} · node ${process.version} · HOME ${home}`, `origin ${origin}`];
      const projects: Array<{ id: string; name: string; root: string }> = [];
      const deps: ReadyDeps = {
        ...host,
        sh: async (command, opts) => {
          ran.push(command);
          const r = await host.sh(command, opts);
          log.push(`$ ${command}\n  → exit ${r.code}${r.code ? `\n  ${r.out.trim().split('\n').slice(-3).join('\n  ')}` : ''}`);
          return r;
        },
        name: () => 'this computer',
        projects: () => projects,
        addProject: async (dir) => {
          projects.push({ id: 'p1', name: path.basename(dir), root: dir });
          return { id: 'p1' };
        },
        // The setup agent isn't under test: the setup its lockfile says.
        workOutSetup: async () => 'npm ci',
      };
      const r = new Readying(deps);
      const steps = (run: ReadyRun): string => run.steps.map((s) => `${s.label}: ${s.state}${s.detail ? ` (${s.detail})` : ''}${s.error ? ` ! ${s.error}` : ''}`).join(' | ');
      const until = async (id: string, states: ReadonlyArray<ReadyRun['state']>, ms: number): Promise<ReadyRun> => {
        const end = Date.now() + ms;
        let seen = '';
        for (;;) {
          const run = r.status(id)!;
          const now = `${run.state} · ${steps(run)}`;
          if (now !== seen) log.push(`[${run.state}] ${steps(run)}`);
          seen = now;
          if (states.includes(run.state)) return run;
          if (Date.now() > end) throw new Error(`Still ${run.state} after ${ms} ms:\n${log.join('\n')}`);
          await new Promise((res) => setTimeout(res, 250));
        }
      };
      const folder = path.join(home, os.platform() === 'darwin' ? 'Projects' : 'projects');
      try {
        // A fresh home: no projects folder yet.
        expect(existsSync(folder)).toBe(false);
        const started = r.start(origin, 'ready-demo');
        const asking = await until(started.id, ['asking', 'failed', 'done'], 120_000);
        expect(asking.state).toBe('asking');
        expect(existsSync(path.join(folder, 'ready-demo', '.nvmrc'))).toBe(true);
        expect(asking.path).toBe(path.join(folder, 'ready-demo'));
        expect(asking.steps.find((s) => s.id === 'tools')?.detail).toMatch(new RegExp(`^Missing on this computer: Node ${WANTED}`));
        expect(asking.missing?.[0]).toMatchObject({ tool: 'node', can: true, sudo: false });
        // Nothing installed before install(): no nvm, no download.
        expect(existsSync(path.join(home, '.nvm'))).toBe(false);
        expect(ran.some((c) => /nvm install|curl /.test(c))).toBe(false);

        r.install(started.id);
        const done = await until(started.id, ['done', 'failed'], 15 * 60_000);
        expect(done.state, log.join('\n')).toBe('done');
        expect(existsSync(path.join(home, '.nvm', 'nvm.sh'))).toBe(true);
        expect(done.steps.find((s) => s.id === 'tools')).toMatchObject({ state: 'done', label: `Node ${WANTED}` });
        expect(done.steps.find((s) => s.id === 'setup')).toMatchObject({ state: 'done', label: 'Setup: npm ci' });
        expect(existsSync(path.join(folder, 'ready-demo', 'node_modules', 'greet', 'package.json'))).toBe(true);
        // Its Node is the one asked for, for this user.
        const node = await host.sh('node --version', { cwd: path.join(folder, 'ready-demo') });
        expect(node.out.trim()).toMatch(new RegExp(`^v${WANTED}\\.`));
        // Never sudo that could ask for a password.
        for (const c of ran) if (/\bsudo\b/.test(c)) expect(c).toMatch(/\bsudo -n\b/);
      } finally {
        const out = path.join(ROOT, '.beluga', 'scratch', `ready-real-${os.platform()}.log`);
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, `${log.join('\n')}\n`);
      }
    },
    20 * 60_000,
  );
});
