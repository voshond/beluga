import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findCodex } from '../src/agent/runtime/codex/app-server.js';
import { worktreeGitDirs } from '../src/workspaces/git.js';
import { CODEX_TRUST_TABLE, PROFILE, codexConfinement, originOf, sideCallConfinement, trustRow, trustTableMarkdown } from '../src/agent/runtime/codex/sandbox.js';

/** A JSON value as TOML (inline tables), for `codex -c key=value`. */
function toml(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')}}`;
}

/** `sh -c script` in `cwd` under Codex's own sandbox, with the run's permissions profile. */
function inCodexSandbox(bin: string, config: Record<string, unknown>, cwd: string, script: string): string {
  const flags = ['default_permissions', `permissions.${PROFILE}`].flatMap((k) => ['-c', `${k}=${toml(config[k])}`]);
  const r = spawnSync(bin, ['sandbox', ...flags, '--', 'sh', '-c', script], { cwd, encoding: 'utf8', timeout: 30_000 });
  return `${r.stdout}${r.stderr}`;
}

describe('the Codex trust table', () => {
  it('says whose run it is', () => {
    expect(originOf({ viaAgent: false })).toBe('own');
    expect(originOf({ viaAgent: true })).toBe('friend');
    expect(originOf({ viaAgent: false, vetTool: () => undefined })).toBe('friend');
    expect(originOf({ guest: true, viaAgent: true })).toBe('guest');
  });

  it('picks a row per origin and reach', () => {
    expect(trustRow('own', 'folder')).toMatchObject({ approval: 'on-request', network: true, yourTools: true });
    expect(trustRow('friend', 'folder')).toMatchObject({ home: 'denied', network: false, approval: 'never', yourTools: false });
    expect(trustRow('friend', 'full')).toMatchObject({ home: 'read', network: false, approval: 'never' });
    expect(trustRow('guest', 'full').sandbox).toBe('refused');
  });

  it('is the table docs/security.md shows', () => {
    const doc = readFileSync(path.resolve(__dirname, '../docs/security.md'), 'utf8');
    const table = /<!-- codex-trust-table -->\n([\s\S]*?)\n<!-- \/codex-trust-table -->/.exec(doc)?.[1];
    expect(table).toBe(trustTableMarkdown());
    expect(CODEX_TRUST_TABLE.length).toBe(table!.split('\n').length - 2);
  });

  it('a main folder is read only, a fix-up worktree in it still writable', () => {
    const c = codexConfinement('own', 'full', { cwd: '/p/main', folders: ['/p/fix'], writable: ['/p/fix'], home: '/h', belugaHome: '/h/.beluga' });
    const profile = c.config[`permissions.${PROFILE}`] as { extends: string; filesystem: Record<string, string> };
    expect(profile.extends).toBe(':read-only');
    // Keyed by the platform's own paths (D:\p\main on Windows), as Codex there reads them.
    const main = path.resolve('/p/main');
    expect(profile.filesystem).toMatchObject({ [main]: 'read', [path.resolve('/p/fix')]: 'write', '/h/.beluga': 'deny', [path.join('/h', '.ssh')]: 'deny', [`${main}/**/.env*`]: 'deny' });
  });

  // Linux's bubblewrap can't mount over a link: "Can't mount on symlink destination ~/.klaud".
  it.skipIf(process.platform === 'win32')('denies a linked secret at its target, never the link', () => {
    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-home-')));
    try {
      mkdirSync(path.join(home, '.beluga'));
      mkdirSync(path.join(home, 'dotfiles', 'gh'), { recursive: true });
      mkdirSync(path.join(home, '.config'));
      symlinkSync(path.join(home, '.beluga'), path.join(home, '.klaud'));
      symlinkSync(path.join(home, 'dotfiles', 'gh'), path.join(home, '.config', 'gh'));
      symlinkSync(path.join(home, 'gone'), path.join(home, '.netrc'));
      const c = codexConfinement('own', 'full', { cwd: '/p/main', folders: [], writable: ['/p/main'], home, belugaHome: path.join(home, '.beluga') });
      const fs = (c.config[`permissions.${PROFILE}`] as { filesystem: Record<string, string> }).filesystem;
      expect(Object.keys(fs).filter((p) => [path.join(home, '.klaud'), path.join(home, '.config', 'gh'), path.join(home, '.netrc')].includes(p))).toEqual([]);
      expect(fs).toMatchObject({ [path.join(home, '.beluga')]: 'deny', [path.join(home, 'dotfiles', 'gh')]: 'deny', [path.join(home, '.ssh')]: 'deny' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

const found = findCodex();
// Installed and actually runs (an npm install whose native binary is missing is a shim that can't start).
const codex = found && spawnSync(found, ['--version'], { timeout: 15_000 }).status === 0 ? found : undefined;
describe.skipIf(!codex || process.platform !== 'darwin')("Codex's own sandbox, as Beluga sets it (the real codex binary)", () => {
  // Inside your home, so a friend reaching only shared folders is kept out of what's beside it.
  // A skipped block's body still runs: nothing made (in ~/Library, or as '' in the repo) unless it runs.
  const runs = Boolean(codex) && process.platform === 'darwin';
  const dir = runs ? realpathSync(mkdtempSync(path.join(os.homedir(), 'Library', 'Caches', 'beluga-codex-sandbox-'))) : '';
  const work = path.join(dir, 'work');
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  if (runs) {
    mkdirSync(path.join(work, 'sub'), { recursive: true });
    writeFileSync(path.join(work, '.env'), 'API_TOKEN=nope');
    writeFileSync(path.join(work, 'sub', '.env.local'), 'API_TOKEN=nope');
    writeFileSync(path.join(work, 'notes.txt'), 'hello');
    writeFileSync(path.join(dir, 'beside.txt'), 'x');
  }
  const script = 'cat notes.txt; echo; cat .env 2>&1 | head -1; cat sub/.env.local 2>&1 | head -1; echo made > made.txt && echo wrote; cat ../beside.txt >/dev/null 2>&1 && echo read-beside || echo beside-denied';

  it.each([
    ['ask me each time / trusted', 'folder'],
    ['full trust', 'full'],
  ] as const)("a friend's task (%s) can't read .env, and works in its folder", (_label, scope) => {
    const c = codexConfinement('friend', scope, { cwd: work, folders: [], writable: [work] });
    const out = inCodexSandbox(codex!, c.config, work, script);
    expect(out).toContain('hello');
    expect(out).toMatch(/\.env: Operation not permitted/);
    expect(out).toMatch(/\.env\.local: Operation not permitted/);
    expect(out).not.toContain('API_TOKEN');
    expect(out).toContain('wrote');
    expect(out).toContain(scope === 'folder' ? 'beside-denied' : 'read-beside');
  });

  it("your own run can't read .env without asking either", () => {
    const c = codexConfinement('own', 'full', { cwd: work, folders: [], writable: [work] });
    const out = inCodexSandbox(codex!, c.config, work, script);
    expect(out).toMatch(/\.env: Operation not permitted/);
    expect(out).not.toContain('API_TOKEN');
    expect(out).toContain('read-beside');
  });
});

describe('a side call on Codex', () => {
  const home = '/Users/someone';
  const cwd = path.resolve('/Users/someone/project');
  const profileOf = (c: ReturnType<typeof sideCallConfinement>) => c.config[`permissions.${PROFILE}`] as { extends: string; filesystem: Record<string, string>; network: { enabled: boolean } };

  it('is read only, never asks, keeps your home and secret files out, and offline', () => {
    const c = sideCallConfinement(cwd, { home, belugaHome: `${home}/.beluga`, yourServers: ['mine'] });
    const p = profileOf(c);
    expect(c.approval).toBe('never');
    expect(p.extends).toBe(':read-only');
    expect(p.network.enabled).toBe(false);
    expect(p.filesystem[home]).toBe('deny');
    expect(p.filesystem[`${cwd}/**/.env*`]).toBe('deny');
    expect(c.config['mcp_servers.mine.enabled']).toBe(false);
  });

  it('given no tools, cannot read the folder either; given Bash, has the network', () => {
    expect(profileOf(sideCallConfinement(cwd, { home })).filesystem[cwd]).toBe('deny');
    expect(profileOf(sideCallConfinement(cwd, { home, tools: ['Read'] })).filesystem[cwd]).toBe('read');
    expect(profileOf(sideCallConfinement(cwd, { home, tools: ['Read', 'Bash'] })).network.enabled).toBe(true);
  });
});

// Checked on Linux (bubblewrap); macOS's seatbelt reads the same profile, not run here.
describe.skipIf(!codex || process.platform !== 'linux')("a worktree's git, in Codex's own sandbox (the real codex binary)", () => {
  it('your own run commits and moves main; hooks and config stay read only; a friend gets none of it', async () => {
    mkdirSync(path.join(os.homedir(), '.cache'), { recursive: true });
    const base = realpathSync(mkdtempSync(path.join(os.homedir(), '.cache', 'beluga-codex-git-')));
    try {
      const repo = path.join(base, 'repo');
      const wt = path.join(base, 'wt');
      const git = (cwd: string, ...args: string[]): string => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout;
      git(base, 'init', '-q', '-b', 'main', repo);
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first');
      git(repo, 'checkout', '-q', '--detach');
      git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
      const gitDirs = (await worktreeGitDirs(wt))!;
      expect(gitDirs.shared).toBe(path.join(repo, '.git'));
      expect(await worktreeGitDirs(repo)).toBeUndefined();
      const script = [
        'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m inside && echo commit-ok',
        'git update-ref refs/heads/main HEAD && echo main-ok',
        `(echo x > ${gitDirs.shared}/hooks/post-commit) 2>/dev/null && echo HOOK-WRITTEN`,
        `(echo x >> ${gitDirs.shared}/config) 2>/dev/null && echo CONFIG-WRITTEN`,
      ].join('; ');
      const own = codexConfinement('own', 'folder', { cwd: wt, folders: [], writable: [wt], gitDirs });
      const out = inCodexSandbox(codex!, own.config, wt, script);
      expect(out).toContain('commit-ok');
      expect(out).toContain('main-ok');
      expect(out).not.toContain('WRITTEN');
      expect(git(repo, 'log', '-1', '--format=%s', 'main').trim()).toBe('inside');
      const friend = codexConfinement('friend', 'full', { cwd: wt, folders: [], writable: [wt], gitDirs });
      expect(inCodexSandbox(codex!, friend.config, wt, script)).not.toMatch(/commit-ok|main-ok/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);
});
