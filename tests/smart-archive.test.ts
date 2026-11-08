import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveWorktree, dropArchive, freeSpace, planArchive, readManifest, restoreWorktree, sweepPartialArchives } from '../src/workspaces/archive.js';
import { deletesSettled } from '../src/workspaces/others.js';
import { regenRule, remakeSteps } from '../src/workspaces/regenerable.js';

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const put = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe('what can be thrown away and made again', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-regen-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('only where the tool that makes it is there', () => {
    put(path.join(root, 'package.json'), '{}');
    put(path.join(root, 'android/app/build.gradle'), '');
    put(path.join(root, 'crates/x/Cargo.toml'), '');
    expect(regenRule(root, 'node_modules/')?.what).toBe('npm packages');
    expect(regenRule(root, 'dist/')?.remake).toBe('npm run build');
    expect(regenRule(root, 'android/app/build/')?.what).toBe('Gradle and Android build output');
    expect(regenRule(root, 'crates/x/target/')?.what).toBe('Rust and Maven build output');
    expect(regenRule(root, 'node_modules/left-pad/index.js')?.what).toBe('npm packages');
    expect(regenRule(root, '.next/')?.what).toBe('JavaScript build caches');
    expect(regenRule(root, 'pkg/foo.egg-info/')?.what).toBe('Python caches');
    // Without its tool beside it, a folder called "target" or "vendor" is yours.
    expect(regenRule(root, 'target/')).toBeUndefined();
    expect(regenRule(root, 'vendor/')).toBeUndefined();
    expect(regenRule(root, 'crates/build/')).toBeUndefined();
    // Local databases and links of yours, whatever tool keeps them.
    expect(regenRule(root, '.wrangler/')).toBeUndefined();
    expect(regenRule(root, '.vercel/')).toBeUndefined();
    expect(regenRule(root, 'notebooks/.cache/')).toBeUndefined();
    expect(regenRule(root, 'infra/.terraform/')).toBeUndefined();
    // Never a file of yours, whatever it's called.
    expect(regenRule(root, '.env')).toBeUndefined();
    expect(regenRule(root, 'thesis/Thesis.pdf')).toBeUndefined();
    expect(regenRule(root, 'apps/web/.DS_Store')?.what).toBe('Finder’s folder settings');
    expect(regenRule(root, 'tsconfig.tsbuildinfo')?.what).toBe('TypeScript build info');
    expect(regenRule(root, 'node_modules')).toBeUndefined();
    expect(remakeSteps([regenRule(root, 'dist/')!, regenRule(root, 'node_modules/')!, regenRule(root, '.next/')!])).toEqual(['npm install', 'npm run build']);
  });
});

describe('a smart archive', () => {
  let base: string;
  let repo: string;
  let wt: string;
  let archives: string;
  const files = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const f of ['src/app.ts', 'src/new.ts', 'notes.md', '.env', 'data/local.db', 'target/keep.txt', 'staged.ts']) if (existsSync(path.join(wt, f))) out[f] = readFileSync(path.join(wt, f), 'utf8');
    return out;
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-archive-')));
    repo = path.join(base, 'repo');
    archives = path.join(base, 'archives');
    mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    put(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n.env\ndata/\ntarget/\n.DS_Store\n');
    put(path.join(repo, 'package.json'), '{"name":"x"}');
    put(path.join(repo, 'src/app.ts'), 'one\n');
    put(path.join(repo, 'gone.ts'), 'bye\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'first');
    wt = path.join(base, 'wt');
    sh(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    put(path.join(wt, 'src/app.ts'), 'one\ntwo\n');
    rmSync(path.join(wt, 'gone.ts'));
    put(path.join(wt, 'staged.ts'), 'staged\n');
    sh(wt, 'add', 'staged.ts');
    put(path.join(wt, 'src/new.ts'), 'untracked\n');
    put(path.join(wt, 'notes.md'), 'mine\n');
    put(path.join(wt, '.env'), 'SECRET=1\n');
    put(path.join(wt, 'data/local.db'), 'rows');
    put(path.join(wt, 'target/keep.txt'), 'no Cargo.toml: yours');
    put(path.join(wt, 'node_modules/left-pad/index.js'), 'x'.repeat(50_000));
    put(path.join(wt, 'dist/app.js'), 'built');
    put(path.join(wt, 'data/sub/more.db'), 'more');
    put(path.join(wt, '.DS_Store'), 'finder');
    symlinkSync('src/app.ts', path.join(wt, 'link.ts'));
  });
  // The folders an archive set aside are still being deleted in the background (a read-only one is made
  // writable only once its first delete fails): deleting the same tree beside it fails with ENOTEMPTY.
  afterEach(async () => {
    await deletesSettled();
    rmSync(base, { recursive: true, force: true });
  });

  it('says what goes and what stays before doing anything', async () => {
    const plan = await planArchive(wt);
    expect(plan.drop.map((d) => d.path).sort()).toEqual(['.DS_Store', 'dist/', 'node_modules/']);
    expect([...plan.keep].sort()).toEqual(['.env', 'data/', 'target/']);
    expect(plan.dropBytes).toBeGreaterThan(40_000);
    expect(plan.remake).toEqual(['npm install', 'npm run build']);
    expect(existsSync(path.join(wt, 'node_modules'))).toBe(true);
  });

  it('keeps everything that isn’t made again, frees the rest, and brings it all back as it was', async () => {
    const before = files();
    const status = sh(wt, 'status', '--porcelain');
    const phases: string[] = [];
    const m = await archiveWorktree({ repo, dir: wt, id: 'w1', archivesDir: archives, onPhase: (p) => phases.push(p) });
    expect(existsSync(wt)).toBe(false);
    expect(phases).toEqual(['saving', 'compressing', 'removing']);
    expect(m.branch).toBe('feature');
    expect(m.freedBytes).toBeGreaterThan(40_000);
    expect(m.dropped.map((d) => d.path).sort()).toEqual(['.DS_Store', 'dist/', 'node_modules/']);
    // The branch stays; the snapshot is kept by a ref of its own (so git never cleans it away).
    expect(sh(repo, 'branch', '--list', 'feature')).toContain('feature');
    expect(sh(repo, 'rev-parse', `refs/klaud/archive/w1`).trim()).toBe(m.snapshot);
    expect(readManifest(archives, 'w1')?.snapshot).toBe(m.snapshot);

    await restoreWorktree({ repo, dir: wt, id: 'w1', archivesDir: archives });
    expect(files()).toEqual(before);
    expect(sh(wt, 'status', '--porcelain')).toBe(status);
    expect(existsSync(path.join(wt, 'gone.ts'))).toBe(false);
    expect(lstatSync(path.join(wt, 'link.ts')).isSymbolicLink()).toBe(true);
    // Windows keeps a link's target with its own slashes.
    expect(readlinkSync(path.join(wt, 'link.ts')).replaceAll('\\', '/')).toBe('src/app.ts');
    // Made again, not kept.
    expect(existsSync(path.join(wt, 'node_modules'))).toBe(false);
    // Restored: the archive is gone with its ref.
    expect(readManifest(archives, 'w1')).toBeUndefined();
    expect(sh(repo, 'for-each-ref', 'refs/klaud/')).toBe('');
  });

  it('throws away the copies of what you sent Claude, keeps the rest of Beluga’s folder, and only when archiving (BLG-771)', async () => {
    put(path.join(repo, '.git/info/exclude'), '.beluga/\n');
    put(path.join(wt, '.beluga/scratch/sent/shot.png'), 'png');
    put(path.join(wt, '.beluga/scratch/sent/mac-assistant/a.pdf'), 'pdf');
    put(path.join(wt, '.beluga/scratch/log.txt'), 'Claude’s');
    put(path.join(wt, '.beluga/reports/r.md'), '# report');
    // Freeing space keeps the worktree, and what you sent it.
    expect((await planArchive(wt)).keep).toContain('.beluga/');
    await freeSpace(wt);
    expect(existsSync(path.join(wt, '.beluga/scratch/sent/shot.png'))).toBe(true);
    const plan = await planArchive(wt, { archiving: true });
    expect(plan.drop.map((d) => d.path)).toContain('.beluga/scratch/sent/');
    expect(plan.drop.find((d) => d.path === '.beluga/scratch/sent/')?.rule.what).toBe('copies of files you sent Claude');
    expect(plan.keep.filter((k) => k.startsWith('.beluga/')).sort()).toEqual(['.beluga/reports/', '.beluga/scratch/log.txt']);
    const m = await archiveWorktree({ repo, dir: wt, id: 'w-sent', archivesDir: archives });
    expect(m.dropped.map((d) => d.path)).toContain('.beluga/scratch/sent/');
    await restoreWorktree({ repo, dir: wt, id: 'w-sent', archivesDir: archives });
    expect(readFileSync(path.join(wt, '.beluga/scratch/log.txt'), 'utf8')).toBe('Claude’s');
    expect(existsSync(path.join(wt, '.beluga/reports/r.md'))).toBe(true);
    expect(existsSync(path.join(wt, '.beluga/scratch/sent'))).toBe(false);
  });

  it('in a folder the project ignores whole, build output goes and the rest stays (BLG-612)', async () => {
    put(path.join(wt, '.gitignore'), `${readFileSync(path.join(wt, '.gitignore'), 'utf8')}mobile/\n`);
    put(path.join(wt, 'mobile/settings.gradle'), '');
    put(path.join(wt, 'mobile/app/build.gradle'), 'android {}');
    put(path.join(wt, 'mobile/app/src/Main.kt'), 'fun main() {}');
    put(path.join(wt, 'mobile/local.properties'), 'sdk.dir=/x');
    put(path.join(wt, 'mobile/app/build/out.bin'), 'b'.repeat(30_000));
    put(path.join(wt, 'mobile/.gradle/cache.bin'), 'c'.repeat(30_000));
    // A git repo of yours inside: never looked into.
    put(path.join(wt, 'mobile/lib/.git/HEAD'), 'ref: refs/heads/main\n');
    put(path.join(wt, 'mobile/lib/build.gradle'), '');
    put(path.join(wt, 'mobile/lib/build/tracked.txt'), 'mine');
    const plan = await planArchive(wt);
    expect(plan.drop.map((d) => d.path)).toEqual(expect.arrayContaining(['mobile/app/build/', 'mobile/.gradle/']));
    expect(plan.drop.map((d) => d.path)).not.toContain('mobile/lib/build/');
    expect(plan.keep).toEqual(expect.arrayContaining(['mobile/app/src/', 'mobile/local.properties', 'mobile/lib/']));
    expect(plan.remake).toContain('./gradlew build');

    await archiveWorktree({ repo, dir: wt, id: 'm1', archivesDir: archives });
    await restoreWorktree({ repo, dir: wt, id: 'm1', archivesDir: archives });
    expect(readFileSync(path.join(wt, 'mobile/app/src/Main.kt'), 'utf8')).toBe('fun main() {}');
    expect(readFileSync(path.join(wt, 'mobile/local.properties'), 'utf8')).toBe('sdk.dir=/x');
    expect(readFileSync(path.join(wt, 'mobile/lib/build/tracked.txt'), 'utf8')).toBe('mine');
    expect(existsSync(path.join(wt, 'mobile/app/build'))).toBe(false);
    expect(existsSync(path.join(wt, 'mobile/.gradle'))).toBe(false);
  });

  it('a folder only your own ignore file hides keeps its build output too', async () => {
    put(path.join(repo, '.git/info/exclude'), 'mine/\n');
    put(path.join(wt, 'mine/build.gradle'), '');
    put(path.join(wt, 'mine/build/out.bin'), 'b');
    const plan = await planArchive(wt);
    expect(plan.drop.map((d) => d.path)).not.toContain('mine/build/');
    expect(plan.keep).toContain('mine/');
  });

  it('a clean worktree with nothing ignored but dependencies keeps no file at all', async () => {
    rmSync(path.join(wt, '.env'));
    rmSync(path.join(wt, 'data'), { recursive: true });
    rmSync(path.join(wt, 'target'), { recursive: true });
    const m = await archiveWorktree({ repo, dir: wt, id: 'w2', archivesDir: archives });
    expect(m.keptFile).toBeUndefined();
    await restoreWorktree({ repo, dir: wt, id: 'w2', archivesDir: archives });
    expect(readFileSync(path.join(wt, 'notes.md'), 'utf8')).toBe('mine\n');
  });

  it('a branch that moved on meanwhile: back at the commit it was on, nothing mixed up', async () => {
    const m = await archiveWorktree({ repo, dir: wt, id: 'w4', archivesDir: archives });
    const other = path.join(base, 'other');
    sh(repo, 'worktree', 'add', '-q', other, 'feature');
    put(path.join(other, 'later.ts'), 'later\n');
    sh(other, 'add', '-A');
    sh(other, 'commit', '-qm', 'later');
    sh(repo, 'worktree', 'remove', other);
    await restoreWorktree({ repo, dir: wt, id: 'w4', archivesDir: archives });
    expect(sh(wt, 'rev-parse', 'HEAD').trim()).toBe(m.head);
    expect(existsSync(path.join(wt, 'later.ts'))).toBe(false);
    expect(readFileSync(path.join(wt, 'src/app.ts'), 'utf8')).toBe('one\ntwo\n');
  });

  it('forgets an archive for good when the worktree is deleted', async () => {
    await archiveWorktree({ repo, dir: wt, id: 'w5', archivesDir: archives });
    await dropArchive(repo, archives, 'w5');
    expect(readManifest(archives, 'w5')).toBeUndefined();
    expect(sh(repo, 'for-each-ref', 'refs/klaud/')).toBe('');
  });

  it('changes nothing when it can’t save everything', async () => {
    await expect(archiveWorktree({ repo, dir: path.join(base, 'nowhere'), id: 'w3', archivesDir: archives })).rejects.toThrow();
    expect(existsSync(wt)).toBe(true);
    expect(readManifest(archives, 'w3')).toBeUndefined();
  });

  it('a git repo of yours inside the worktree is kept whole, history and all', async () => {
    const nested = path.join(wt, 'tools/mine');
    mkdirSync(nested, { recursive: true });
    sh(nested, 'init', '-q', '-b', 'main');
    put(path.join(nested, 'a.txt'), 'nested work\n');
    sh(nested, 'add', '-A');
    sh(nested, 'commit', '-qm', 'nested');
    const commit = sh(nested, 'rev-parse', 'HEAD').trim();
    put(path.join(nested, 'b.txt'), 'uncommitted in nested\n');
    await archiveWorktree({ repo, dir: wt, id: 'n1', archivesDir: archives });
    await restoreWorktree({ repo, dir: wt, id: 'n1', archivesDir: archives });
    expect(sh(nested, 'rev-parse', 'HEAD').trim()).toBe(commit);
    expect(readFileSync(path.join(nested, 'b.txt'), 'utf8')).toBe('uncommitted in nested\n');
  });

  it('won’t archive a submodule’s local work (it lives in the worktree’s own git folder)', async () => {
    const lib = path.join(base, 'lib');
    mkdirSync(lib);
    sh(lib, 'init', '-q', '-b', 'main');
    put(path.join(lib, 'x.txt'), 'lib\n');
    sh(lib, 'add', '-A');
    sh(lib, 'commit', '-qm', 'lib');
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib'], { cwd: wt });
    put(path.join(wt, 'vendor/lib/x.txt'), 'changed in the submodule\n');
    await expect(archiveWorktree({ repo, dir: wt, id: 's1', archivesDir: archives })).rejects.toThrow(/submodule/);
    expect(existsSync(path.join(wt, 'vendor/lib/x.txt'))).toBe(true);
    expect(readManifest(archives, 's1')).toBeUndefined();
  });

  it('won’t archive in the middle of a merge, rebase or cherry-pick', async () => {
    const gitDir = sh(wt, 'rev-parse', '--absolute-git-dir').trim();
    writeFileSync(path.join(gitDir, 'MERGE_HEAD'), `${sh(wt, 'rev-parse', 'HEAD').trim()}\n`);
    await expect(archiveWorktree({ repo, dir: wt, id: 'm1', archivesDir: archives })).rejects.toThrow(/merge/);
    expect(existsSync(wt)).toBe(true);
  });

  it('one archive of a worktree at a time', async () => {
    const first = archiveWorktree({ repo, dir: wt, id: 'c1', archivesDir: archives });
    await expect(archiveWorktree({ repo, dir: wt, id: 'c1', archivesDir: archives })).rejects.toThrow(/already/);
    await first;
    expect(readManifest(archives, 'c1')).toBeDefined();
  });

  it('a restore that fails leaves no half-made folder, and the archive to try again', async () => {
    await archiveWorktree({ repo, dir: wt, id: 'r1', archivesDir: archives });
    const kept = path.join(archives, 'r1', 'kept.tar.xz');
    const good = readFileSync(kept);
    writeFileSync(kept, 'not an archive');
    await expect(restoreWorktree({ repo, dir: wt, id: 'r1', archivesDir: archives })).rejects.toThrow();
    expect(existsSync(wt)).toBe(false);
    writeFileSync(kept, good);
    await restoreWorktree({ repo, dir: wt, id: 'r1', archivesDir: archives });
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('only what git ignores goes: in a folder partly ignored, your files in it stay', async () => {
    put(path.join(repo, '.gitignore'), 'build/*.map\n!build/index.html\nnode_modules/\n');
    put(path.join(wt, '.gitignore'), 'build/*.map\n!build/index.html\nnode_modules/\n');
    put(path.join(wt, 'build/index.html'), '<html>');
    sh(wt, 'add', 'build/index.html');
    put(path.join(wt, 'build/notes.txt'), 'mine');
    put(path.join(wt, 'build/app.js.map'), 'map');
    const plan = await planArchive(wt);
    expect(plan.drop.map((d) => d.path)).toContain('build/app.js.map');
    expect(plan.drop.map((d) => d.path)).not.toContain('build/');
    await freeSpace(wt);
    expect(existsSync(path.join(wt, 'build/index.html'))).toBe(true);
    expect(existsSync(path.join(wt, 'build/notes.txt'))).toBe(true);
    expect(existsSync(path.join(wt, 'build/app.js.map'))).toBe(false);
  });

  it('what only your own global ignore file hides is kept (the project never said it’s throwaway)', async () => {
    const global = path.join(base, 'global-ignore');
    writeFileSync(global, 'out/\n');
    sh(repo, 'config', 'core.excludesFile', global);
    put(path.join(wt, 'out/report.pdf'), 'hand made');
    const plan = await planArchive(wt);
    expect(plan.drop.map((d) => d.path)).not.toContain('out/');
    expect(plan.keep).toContain('out/');
  });

  it('a folder it can’t remove completely keeps its archive, and restoring sets what’s left aside', async () => {
    const locked = path.join(wt, 'node_modules/locked');
    put(path.join(locked, 'x.js'), 'x');
    execFileSync('chmod', ['a-w', locked]);
    try {
      const m = await archiveWorktree({ repo, dir: wt, id: 'p1', archivesDir: archives });
      expect(readManifest(archives, 'p1')?.snapshot).toBe(m.snapshot);
      expect(sh(repo, 'rev-parse', 'refs/klaud/archive/p1').trim()).toBe(m.snapshot);
    } finally {
      if (existsSync(locked)) execFileSync('chmod', ['-R', 'u+w', wt]);
    }
    // Something left where it was (or not): restore brings it all back either way.
    if (!existsSync(wt)) mkdirSync(path.join(wt, 'node_modules'), { recursive: true });
    await restoreWorktree({ repo, dir: wt, id: 'p1', archivesDir: archives });
    expect(readFileSync(path.join(wt, 'notes.md'), 'utf8')).toBe('mine\n');
    expect(readFileSync(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('throws away an archive cut short by a quit, and keeps finished ones', async () => {
    await archiveWorktree({ repo, dir: wt, id: 'done1', archivesDir: archives });
    put(path.join(archives, 'cut1.partial/kept.tar.xz'), 'half written');
    put(path.join(archives, 'notes.partial.txt'), 'not an archive');
    expect(await sweepPartialArchives(archives)).toBe(1);
    await deletesSettled();
    expect(readdirSync(archives).sort()).toEqual(['done1', 'notes.partial.txt']);
    expect(readManifest(archives, 'done1')).toBeDefined();
    expect(await sweepPartialArchives(path.join(base, 'nowhere'))).toBe(0);
  });

  it('a second archive never replaces one that’s there', async () => {
    await archiveWorktree({ repo, dir: wt, id: 'd1', archivesDir: archives });
    mkdirSync(wt);
    await expect(archiveWorktree({ repo, dir: wt, id: 'd1', archivesDir: archives })).rejects.toThrow(/already archived/);
  });

  it('won’t archive a submodule with files of its own git ignores, a stash, or a branch only here', async () => {
    const lib = path.join(base, 'lib2');
    mkdirSync(lib);
    sh(lib, 'init', '-q', '-b', 'main');
    put(path.join(lib, '.gitignore'), '.env\n');
    put(path.join(lib, 'x.txt'), 'lib\n');
    sh(lib, 'add', '-A');
    sh(lib, 'commit', '-qm', 'lib');
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'libs/two'], { cwd: wt });
    const sub = path.join(wt, 'libs/two');
    put(path.join(sub, '.env'), 'SUB_SECRET=1');
    await expect(archiveWorktree({ repo, dir: wt, id: 's2', archivesDir: archives })).rejects.toThrow(/submodule libs\/two/);
    rmSync(path.join(sub, '.env'));
    // A commit on another branch, only here (the submodule is back on its pushed commit).
    sh(sub, 'checkout', '-q', '-b', 'only-here');
    put(path.join(sub, 'y.txt'), 'local\n');
    sh(sub, 'add', '-A');
    sh(sub, 'commit', '-qm', 'local');
    sh(sub, 'checkout', '-q', '-');
    await expect(archiveWorktree({ repo, dir: wt, id: 's2', archivesDir: archives })).rejects.toThrow(/submodule libs\/two/);
    expect(existsSync(sub)).toBe(true);
  });

  it('a repo inside whose git data lives elsewhere (a .git file) isn’t archived', async () => {
    put(path.join(wt, 'linked/.git'), 'gitdir: /somewhere/else\n');
    put(path.join(wt, 'linked/a.txt'), 'a');
    await expect(archiveWorktree({ repo, dir: wt, id: 'g1', archivesDir: archives })).rejects.toThrow(/linked/);
    expect(existsSync(wt)).toBe(true);
  });

  it('brings files back byte for byte, whatever git would do to their line endings', async () => {
    sh(repo, 'config', 'core.autocrlf', 'input');
    writeFileSync(path.join(wt, 'crlf.txt'), 'one\r\ntwo\r\n');
    await archiveWorktree({ repo, dir: wt, id: 'l1', archivesDir: archives });
    await restoreWorktree({ repo, dir: wt, id: 'l1', archivesDir: archives });
    expect(readFileSync(path.join(wt, 'crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
  });

  it('keeps empty folders of yours', async () => {
    mkdirSync(path.join(wt, 'uploads/empty'), { recursive: true });
    await archiveWorktree({ repo, dir: wt, id: 'e1', archivesDir: archives });
    await restoreWorktree({ repo, dir: wt, id: 'e1', archivesDir: archives });
    expect(existsSync(path.join(wt, 'uploads/empty'))).toBe(true);
  });

  it('frees space in a worktree you keep: only what’s made again', async () => {
    const freed = await freeSpace(wt);
    expect(freed.bytes).toBeGreaterThan(40_000);
    expect(existsSync(path.join(wt, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(wt, '.env'))).toBe(true);
    expect(existsSync(path.join(wt, 'target/keep.txt'))).toBe(true);
  });
});
