import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Never read the developer's real ~/.claude: a fake Claude Code home for this file.
const CLAUDE_HOME = mkdtempSync(path.join(os.tmpdir(), 'klaud-claude-home-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE_HOME;

const { encodeProjectDir, findConversation, listConversations, pathVariants, samePath, sessionTitle } = await import('../src/agent/runtime/claude/claude-sessions.js');
const { findCreators, worktreeAddTargets } = await import('../src/agent/runtime/claude/worktree-creators.js');
const { describeOrigin, sourceFromPath, worktreeOrigin } = await import('../src/workspaces/origin.js');
const { deletesSettled, removeWorktreeKeepingBranch, renameFolder, staleReason, sweepSetAside, worktreeFacts } = await import('../src/workspaces/others.js');
const { parseConductorRows, inConductorRoot } = await import('../src/workspaces/conductor.js');
const { OtherWorktrees } = await import('../src/core/other-worktrees.js');
const { WorkspaceManager } = await import('../src/workspaces/manager.js');
const { WorkspaceStore } = await import('../src/workspaces/store.js');

const self = { id: 'me', name: 'kay' };
let counter = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

/** Write a Claude Code transcript the way Claude Code files it: under the folder name as recorded. */
function writeSession(recordedCwd: string, lines: Array<{ type: 'user' | 'assistant'; content: unknown }>, opts: { at?: number; id?: string; title?: string } = {}): string {
  const id = opts.id ?? uuid();
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectDir(recordedCwd));
  mkdirSync(dir, { recursive: true });
  const t0 = opts.at ?? Date.parse('2026-10-01T10:00:00Z');
  let parent: string | null = null;
  const entries = lines.map((l, i) => {
    const uuidOf = `${id}-${i}`;
    const e = { parentUuid: parent, isSidechain: false, type: l.type, message: { role: l.type, ...(l.type === 'assistant' ? { model: 'claude-opus-5' } : {}), content: l.content }, uuid: uuidOf, timestamp: new Date(t0 + i * 1000).toISOString(), cwd: recordedCwd, sessionId: id, version: '2.1.257', userType: 'external' };
    parent = uuidOf;
    return JSON.stringify(e);
  });
  if (opts.title) entries.push(JSON.stringify({ type: 'ai-title', aiTitle: opts.title, sessionId: id }));
  writeFileSync(path.join(dir, `${id}.jsonl`), `${entries.join('\n')}\n`);
  return id;
}

const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

describe('finding Claude Code conversations for a folder', () => {
  it('encodes folders the way Claude Code does (every non-alphanumeric character, _ and . included)', () => {
    expect(encodeProjectDir('/Users/k/Desktop/ratel/_pr-review/catalog-v2/ratel.154')).toBe('-Users-k-Desktop-ratel--pr-review-catalog-v2-ratel-154');
  });

  // Not on Windows: macOS's /private links.
  it.skipIf(process.platform === 'win32')('treats /tmp and /private/tmp (and symlinks) as one folder', () => {
    expect(pathVariants('/tmp/x')).toEqual(expect.arrayContaining(['/tmp/x', '/private/tmp/x']));
    expect(samePath('/tmp/does-not-exist-klaud', '/private/tmp/does-not-exist-klaud')).toBe(true);
    expect(samePath('/tmp/a', '/tmp/b')).toBe(false);
    const real = realpathSync(os.tmpdir());
    expect(samePath(os.tmpdir(), real)).toBe(true);
  });

  it('cleans titles: tool instructions out, long ones cut', () => {
    expect(sessionTitle({ summary: '<system_instruction>You are in Conductor</system_instruction>\n\nfix   the login' })).toBe('fix the login');
    expect(sessionTitle({ customTitle: 'Mine', summary: 'x' })).toBe('Mine');
    expect(sessionTitle({ summary: 'a'.repeat(200) })).toHaveLength(80);
  });

  it('finds a conversation recorded under the resolved path when the folder is given through a symlink', async () => {
    const target = mkdtempSync(path.join(os.tmpdir(), 'klaud-wt-a_b.'));
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'klaud-wt-link-')), 'a_b'); // a symlink on every platform, not just macOS's /var → /private/var
    symlinkSync(target, dir);
    const real = realpathSync(dir);
    expect(real).not.toBe(dir);
    writeSession(real, [
      { type: 'user', content: '<system_instruction>\nYou are working inside Conductor.\n</system_instruction>\n\nfix the login bug' },
      { type: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${real}/src/login.ts` } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
      { type: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] },
      { type: 'user', content: '[Request interrupted by user]' },
    ]);
    const found = await findConversation(dir, self);
    expect(found?.items.map((i) => i.type)).toEqual(['chat', 'agent']);
    expect(found?.items[0]).toMatchObject({ type: 'chat', text: 'fix the login bug' });
    expect(found?.items[1]).toMatchObject({ type: 'agent', text: 'Fixed it.' });
    const steps = found?.items[1]?.type === 'agent' ? found.items[1].steps : [];
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('src/login.ts');
  });

  it('finds a conversation filed under the unresolved spelling of the folder too', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-wt-unresolved-'));
    const id = writeSession(dir, [
      { type: 'user', content: 'hello from the symlinked path' },
      { type: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect((await listConversations(realpathSync(dir))).map((c) => c.sessionId)).toEqual([id]);
    const found = await findConversation(realpathSync(dir), self);
    expect(found?.sessionId).toBe(id);
  });

  it('lists every conversation newest first, prefers the one asked for, and only ever opens one from that folder', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-wt-many-')));
    const old = writeSession(dir, [{ type: 'user', content: 'first task' }, { type: 'assistant', content: [{ type: 'text', text: 'done 1' }] }], { at: Date.parse('2026-09-01T00:00:00Z'), title: 'First' });
    const recent = writeSession(dir, [{ type: 'user', content: 'second task' }, { type: 'assistant', content: [{ type: 'text', text: 'done 2' }] }], { at: Date.parse('2026-10-01T00:00:00Z'), title: 'Second' });
    // Only machine lines: nothing to show, so it's skipped in favour of the next.
    const empty = writeSession(dir, [{ type: 'user', content: '<command-name>/clear</command-name>' }], { at: Date.parse('2026-10-02T00:00:00Z') });
    const elsewhere = writeSession(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-wt-other-'))), [{ type: 'user', content: 'x' }, { type: 'assistant', content: [{ type: 'text', text: 'y' }] }]);
    const { utimesSync } = await import('node:fs');
    const file = (id: string, when: string): void => utimesSync(path.join(CLAUDE_HOME, 'projects', encodeProjectDir(dir), `${id}.jsonl`), new Date(when), new Date(when));
    file(old, '2026-09-01T00:00:00Z');
    file(recent, '2026-10-01T00:00:00Z');
    file(empty, '2026-10-02T00:00:00Z');
    const list = await listConversations(dir);
    expect(list.map((c) => c.sessionId)).toEqual([empty, recent, old]);
    expect((await findConversation(dir, self))?.sessionId).toBe(recent);
    const preferred = await findConversation(dir, self, { prefer: old });
    expect(preferred?.sessionId).toBe(old);
    expect(preferred?.title).toBe('First');
    expect(preferred?.all?.length).toBe(3);
    expect((await findConversation(dir, self, { sessionId: old }))?.items[0]).toMatchObject({ text: 'first task' });
    expect(await findConversation(dir, self, { sessionId: elsewhere })).toBeUndefined();
  });
});

describe('which conversation made a worktree', () => {
  // Not on Windows: POSIX paths in the commands.
  it.skipIf(process.platform === 'win32')('reads the folders `git worktree add` makes, following cd and -C', () => {
    expect(worktreeAddTargets('git worktree add /abs/wt -b feat', '/repo')).toEqual(['/abs/wt']);
    expect(worktreeAddTargets('cd /Users/k/repo && git worktree add ../rc210-replay feat/x', '/elsewhere')).toEqual(['/Users/k/rc210-replay']);
    expect(worktreeAddTargets('git -C /Users/k/repo worktree add -B pr-154 "../_pr review/ratel-154" origin/pr', '/x')).toEqual(['/Users/k/_pr review/ratel-154']);
    expect(worktreeAddTargets('git fetch && git worktree add --detach wt2', '/repo')).toEqual(['/repo/wt2']);
    expect(worktreeAddTargets('git worktree add "$DIR" main; git worktree list', '/repo')).toEqual([]);
    expect(worktreeAddTargets('git worktree add ~/wt', '/repo')).toEqual([path.join(os.homedir(), 'wt')]);
    expect(worktreeAddTargets('git worktree remove /abs/wt', '/repo')).toEqual([]);
  });

  it('finds the session whose Bash call made the folder, with its title', async () => {
    const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-creator-')));
    const target = path.join(path.dirname(repo), `${path.basename(repo)}-replay`);
    const id = writeSession(repo, [
      { type: 'user', content: 'make a worktree for the replay' },
      { type: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `git worktree add ../${path.basename(target)} -b replay` } }] },
      { type: 'assistant', content: [{ type: 'text', text: 'Made it.' }] },
    ], { title: 'RC-210 epic' });
    const found = await findCreators([target, '/nowhere/else'], { since: 0, fresh: true });
    expect(found.get(target)).toMatchObject({ sessionId: id, title: 'RC-210 epic', cwd: repo });
    expect(found.has('/nowhere/else')).toBe(false);
  });
});

describe('labelling worktrees by who made them', () => {
  it('tells Conductor, Claude Code and the rest apart', () => {
    expect(sourceFromPath('/Users/k/conductor/workspaces/ratel-cloud/berlin')).toBe('conductor');
    expect(sourceFromPath('/Users/k/repo/.claude/worktrees/agent-a1')).toBe('claude');
    expect(sourceFromPath('/Users/k/Desktop/ratel/ratel-turns')).toBe('other');
    expect(worktreeOrigin({ external: true, path: '/r/.claude/worktrees/agent-1' })).toBe('agent');
    expect(inConductorRoot('/h/conductor/workspaces/app/lisbon', '/h')).toBe(true);
  });

  it('names each origin', () => {
    // Another app's worktrees are told apart (to keep its live ones safe) but never named.
    expect(describeOrigin({ path: '/h/conductor/workspaces/app/berlin' })).toMatchObject({ source: 'conductor', label: 'Made outside Beluga' });
    const archived = describeOrigin({ path: '/custom/place/berlin', conductor: { name: 'Open Source Strategy', state: 'archived', prTitle: 'feat: x' } });
    expect(archived).toMatchObject({ source: 'conductor', label: 'Made outside Beluga', detail: expect.stringContaining('put it away') });
    expect(archived.detail).toContain('Pull request: feat: x');
    for (const o of [archived, describeOrigin({ path: '/h/conductor/workspaces/app/berlin' })]) expect(`${o.label} ${o.detail}`).not.toMatch(/conductor/i);
    expect(describeOrigin({ path: '/r/.claude/worktrees/agent-1' })).toMatchObject({ source: 'claude', label: 'Claude Code sub-agent' });
    expect(describeOrigin({ path: '/d/rc210-replay', creator: { title: 'RC-210 epic', cwd: '/d/ratel-cloud' } })).toMatchObject({ source: 'claude', label: 'Made by Claude in “RC-210 epic”', detail: expect.stringContaining('ratel-cloud') });
    expect(describeOrigin({ path: '/d/scratch' })).toMatchObject({ source: 'other', label: 'Made outside Beluga' });
  });

  it("reads Conductor's rows: the live workspace wins over archived ones at the same folder", () => {
    const rows = JSON.stringify([
      { path: '/c/app/berlin', dir: 'berlin', name: null, state: 'archived', updatedAt: '2026-10-02', sessionId: 'old', sessionTitle: 'Old' },
      { path: '/c/app/berlin', dir: 'berlin', name: '', state: 'ready', updatedAt: '2026-10-01', sessionId: 'live', sessionTitle: 'Untitled', prTitle: 'feat: shell' },
      { path: null, dir: 'x' },
    ]);
    const list = parseConductorRows(rows);
    expect(list).toEqual([{ path: '/c/app/berlin', name: 'berlin', state: 'ready', prTitle: 'feat: shell', sessionId: 'live', updatedAt: '2026-10-01' }]);
    expect(parseConductorRows('not json')).toEqual([]);
  });
});

describe('stale worktrees', () => {
  it('only ones with nothing of their own can go', () => {
    const f = { missing: false, changed: 0, merged: false, upstreamGone: false };
    expect(staleReason({ ...f, missing: true })).toBe('missing');
    expect(staleReason({ ...f, merged: true })).toBe('merged');
    expect(staleReason({ ...f, upstreamGone: true })).toBe('gone');
    expect(staleReason({ ...f, merged: true, changed: 2 })).toBeUndefined();
    expect(staleReason(f)).toBeUndefined();
  });
});

describe('worktrees from other tools, end to end in a real repo', () => {
  let base: string;
  let repo: string;
  let mgr: InstanceType<typeof WorkspaceManager>;
  let toasts: string[];
  let others: InstanceType<typeof OtherWorktrees>;
  const ext = (name: string) => mgr.list.flatMap((p) => p.workspaces).find((w) => w.name === name)!;

  beforeAll(() => {
    expect(existsSync(CLAUDE_HOME)).toBe(true);
  });

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-others-')));
    const origin = path.join(base, 'app.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
    repo = path.join(base, 'code', 'app');
    mkdirSync(repo, { recursive: true });
    sh(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'README.md'), '# hi\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'init');
    sh(repo, 'remote', 'add', 'origin', origin);
    sh(repo, 'push', '-q', '-u', 'origin', 'main');
    sh(repo, 'remote', 'set-head', 'origin', 'main');
    // A merged one (nothing of its own), one with a commit, one with uncommitted work, one whose folder is gone.
    sh(repo, 'worktree', 'add', '-q', '-b', 'done', path.join(base, 'done'));
    sh(repo, 'worktree', 'add', '-q', '-b', 'busy', path.join(base, 'busy'));
    writeFileSync(path.join(base, 'busy', 'new.txt'), 'x');
    sh(path.join(base, 'busy'), 'add', '.');
    sh(path.join(base, 'busy'), 'commit', '-q', '-m', 'work');
    sh(repo, 'worktree', 'add', '-q', '-b', 'dirty', path.join(base, 'dirty'));
    writeFileSync(path.join(base, 'dirty', 'wip.txt'), 'x');
    sh(repo, 'worktree', 'add', '-q', '-b', 'gone', path.join(base, 'gone'));
    rmSync(path.join(base, 'gone'), { recursive: true, force: true });
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    mgr = new WorkspaceManager(store);
    await mgr.refresh();
    toasts = [];
    others = new OtherWorktrees({ manager: mgr, refresh: async () => void (await mgr.refresh()), toast: (t) => toasts.push(t) });
  });

  it('describes one: origin, dates, merged, uncommitted', async () => {
    const info = await others.info(ext('busy').id);
    expect(info).toMatchObject({ name: 'busy', branch: 'busy', base: 'origin/main', ahead: 1, changed: 0, merged: false, missing: false, origin: { source: 'other', label: 'Made outside Beluga' }, conversations: [] });
    expect(info?.createdAt).toBeGreaterThan(0);
    expect(info?.lastCommit?.subject).toBe('work');
    expect(info?.stale).toBeUndefined();
    expect((await others.info(ext('done').id))?.stale).toBe('merged');
    expect((await worktreeFacts({ path: path.join(base, 'gone'), branch: 'gone' }, 'origin/main')).missing).toBe(true);
    // Beluga's own main folder isn't one of these.
    expect(await others.info(mgr.list.find((p) => p.root)!.workspaces.find((w) => w.kind === 'main')!.id)).toBeUndefined();
  });

  it('says when git last saw something happen in each one (a commit moves it forward)', async () => {
    const projectId = mgr.list.find((p) => p.root)!.id;
    const before = await others.activity(projectId);
    expect(Object.keys(before).sort()).toEqual([ext('busy').id, ext('dirty').id, ext('done').id].sort());
    expect(before[ext('busy').id]).toBeGreaterThan(0);
    const { utimesSync } = await import('node:fs');
    const admin = sh(ext('done').path, 'rev-parse', '--absolute-git-dir').trim();
    const old = new Date(Date.now() - 86_400_000);
    for (const f of ['logs/HEAD', 'index', 'HEAD']) if (existsSync(path.join(admin, f))) utimesSync(path.join(admin, f), old, old);
    expect((await others.activity(projectId))[ext('done').id]).toBeLessThan(before[ext('busy').id]!);
    sh(ext('done').path, 'commit', '-q', '--allow-empty', '-m', 'later');
    expect((await others.activity(projectId))[ext('done').id]).toBeGreaterThan(old.getTime() + 1000);
  });

  it('lists stale ones and removes only what you ticked, keeping branches', async () => {
    const stale = await others.stale(mgr.list.find((p) => p.root)!.id);
    expect(stale.map((s) => [s.name, s.reason]).sort()).toEqual([
      ['done', 'merged'],
      ['gone', 'missing'],
    ]);
    const projectId = mgr.list.find((p) => p.root)!.id;
    const res = await others.cleanUp(projectId, [ext('done').id, ext('gone').id, ext('busy').id]);
    expect(res).toEqual({ removed: 2, kept: 1 });
    expect(existsSync(path.join(base, 'done'))).toBe(false);
    expect(existsSync(path.join(base, 'busy'))).toBe(true);
    expect(sh(repo, 'branch', '--list', 'done', 'gone').trim().split(/\s+/).sort()).toEqual(['done', 'gone']);
    expect(sh(repo, 'worktree', 'list')).not.toContain(path.join(base, 'gone'));
  });

  it('refuses to remove one with uncommitted changes until you confirm, and keeps its branch', async () => {
    const dirty = ext('dirty');
    expect(await others.remove(dirty.id)).toBe(false);
    expect(toasts.at(-1)).toContain('uncommitted');
    expect(existsSync(dirty.path)).toBe(true);
    expect(await others.remove(dirty.id, true)).toBe(true);
    expect(existsSync(dirty.path)).toBe(false);
    expect(sh(repo, 'branch', '--list', 'dirty')).toContain('dirty');
  });

  it('sets the folder aside at once and deletes it in the background; a dirty one without force is still refused by git', async () => {
    const dirty = ext('dirty');
    writeFileSync(path.join(dirty.path, 'node_modules.txt'), 'x'.repeat(1000));
    await removeWorktreeKeepingBranch(repo, dirty.path, true);
    expect(existsSync(dirty.path)).toBe(false);
    expect(sh(repo, 'worktree', 'list')).not.toContain(dirty.path);
    await deletesSettled();
    expect(readdirSync(base).filter((n) => n.includes('.removing-'))).toEqual([]);
    expect(sh(repo, 'branch', '--list', 'dirty')).toContain('dirty');
    // Without force, git's own refusal stands: the folder stays where it was.
    sh(repo, 'worktree', 'add', '-q', '-b', 'dirty2', path.join(base, 'dirty2'));
    writeFileSync(path.join(base, 'dirty2', 'wip.txt'), 'x');
    await expect(removeWorktreeKeepingBranch(repo, path.join(base, 'dirty2'), false)).rejects.toThrow();
    expect(existsSync(path.join(base, 'dirty2', 'wip.txt'))).toBe(true);
  });

  it('finishes deleting what an earlier background delete left, and only that', async () => {
    const parent = path.join(base, 'wts'); // not looked in yet this run (refresh already swept base)
    mkdirSync(path.join(parent, '.old.removing-123', 'node_modules'), { recursive: true });
    mkdirSync(path.join(parent, '.keep-me'));
    mkdirSync(path.join(parent, 'work'));
    await sweepSetAside([parent]);
    await deletesSettled();
    expect(existsSync(path.join(parent, '.old.removing-123'))).toBe(false);
    expect(existsSync(path.join(parent, '.keep-me'))).toBe(true);
    expect(existsSync(path.join(parent, 'work'))).toBe(true);
  });

  it("deleting one you've talked in from Beluga never deletes its branch or forces it", async () => {
    const busy = ext('busy');
    mgr.rememberSession(busy.id, 'sess-1'); // adopted: now one of yours
    await mgr.refresh();
    expect(ext('busy').external).toBe(false);
    await mgr.remove(busy.id);
    expect(existsSync(busy.path)).toBe(false);
    expect(sh(repo, 'branch', '--list', 'busy')).toContain('busy');
    // With uncommitted work it refuses instead of forcing.
    const dirty = ext('dirty');
    mgr.rememberSession(dirty.id, 'sess-2');
    await mgr.refresh();
    await expect(mgr.remove(dirty.id)).rejects.toThrow();
    expect(existsSync(dirty.path)).toBe(true);
  });

  it('labels with the conversation that made it, and lists conversations that ran there', async () => {
    const busy = ext('busy');
    const tools = {
      conversationsUnder: async () => [],
      conversations: async (dir: string) => (dir === busy.path ? [{ sessionId: 's1', title: 'Earlier', lastModified: 1 }] : []),
      conductor: async () => [],
      creators: async (paths: readonly string[]) => new Map(paths.map((p) => [p, { sessionId: 'maker', title: 'RC-210 epic', cwd: repo }])),
    };
    const withTools = new OtherWorktrees({ manager: mgr, refresh: async () => void (await mgr.refresh()), toast: () => undefined, tools });
    const info = await withTools.info(busy.id);
    expect(info?.origin.label).toBe('Made by Claude in “RC-210 epic”');
    expect(info?.conversations.map((c) => c.title)).toEqual(['Earlier']);
    const origins = await withTools.origins(busy.projectId);
    expect(origins[busy.id]?.source).toBe('claude');
  });
});

describe('opening a worktree from another tool', () => {
  it("shows its conversation without making it yours, picks another, and resumes it once you talk there", async () => {
    const { Store, initialState } = await import('../src/core/store.js');
    const { ShareService } = await import('../src/core/shares.js');
    const { WorkspaceController } = await import('../src/core/workspace-controller.js');
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-open-other-')));
    const repo = path.join(base, 'code', 'app');
    mkdirSync(repo, { recursive: true });
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = path.join(base, 'conductor', 'workspaces', 'app', 'berlin');
    sh(repo, 'worktree', 'add', '-q', '-b', 'feat/berlin', wt);
    const wsStore = new WorkspaceStore(path.join(base, 'home'));
    wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    const mgr = new WorkspaceManager(wsStore);
    const store = new Store(initialState('room'));
    const asked: Array<{ dir: string; opts?: { sessionId?: string; prefer?: string } }> = [];
    const convo = (sessionId: string, text: string) => ({ sessionId, title: text, lastModified: 1, items: [{ id: 't-0', type: 'chat' as const, channel: '', from: 'me', name: 'kay', text, ts: 1, byAgent: false }] });
    const ctl = new WorkspaceController({
      manager: mgr,
      store,
      shares: new ShareService([]),
      selfId: () => 'me',
      toast: () => undefined,
      intend: () => undefined,
      askClaude: () => undefined,
      findConversation: async (dir, opts) => (asked.push({ dir, ...(opts ? { opts } : {}) }), opts?.sessionId === 'older' ? convo('older', 'the older one') : convo('active', 'the one Conductor has open')),
      otherTools: { conversations: async () => [], conversationsUnder: async () => [], conductor: async () => [{ path: wt, name: 'berlin', sessionId: 'active' }], creators: async () => new Map() },
    });
    await ctl.refresh();
    const ws = mgr.list.flatMap((p) => p.workspaces).find((w) => w.path === wt)!;
    expect(ws.external).toBe(true);
    ctl.open(ws.id);
    const channel = `ws:${ws.id}`;
    const said = () => store.getState().log.filter((l) => l.channel === channel && l.type === 'chat').map((l) => (l.type === 'chat' ? l.text : ''));
    for (let i = 0; i < 50 && !said().length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(said()).toEqual(['the one Conductor has open']);
    expect(asked[0]?.opts).toEqual({ prefer: 'active' });
    // Still not yours: it stays where it is in the sidebar.
    expect(mgr.find(ws.id)?.external).toBe(true);
    expect(ctl.place(channel)?.resume).toBe('active');
    expect(await ctl.showConversation(ws.id, 'older')).toBe(true);
    expect(said()).toEqual(['the older one']);
    const place = ctl.place(channel)!;
    expect(place.resume).toBe('older');
    // Talking there (Claude starts a session) makes it yours.
    place.onSession?.('older');
    await mgr.refresh();
    expect(mgr.find(ws.id)).toMatchObject({ external: false, sessionId: 'older' });
    expect(await ctl.showConversation(ws.id, 'active')).toBe(false);
    ctl.stop();
  });
});

describe("Conductor's live workspaces", () => {
  // Not on Windows: Conductor is a Mac app.
  it.skipIf(process.platform === 'win32')('are never offered for cleanup or removed by Clean Up (archive them in Conductor)', async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-conductor-live-')));
    const repo = path.join(base, 'code', 'app');
    mkdirSync(repo, { recursive: true });
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const live = path.join(base, 'conductor', 'workspaces', 'app', 'lisbon');
    const archived = path.join(base, 'conductor', 'workspaces', 'app', 'medan');
    sh(repo, 'worktree', 'add', '-q', '-b', 'lisbon', live);
    sh(repo, 'worktree', 'add', '-q', '-b', 'medan', archived);
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    const mgr = new WorkspaceManager(store);
    await mgr.refresh();
    const tools = {
      conversationsUnder: async () => [],
      conversations: async () => [],
      conductor: async () => [
        { path: live, name: 'lisbon', state: 'ready' },
        { path: archived, name: 'medan', state: 'archived' },
      ],
      creators: async () => new Map(),
    };
    const others = new OtherWorktrees({ manager: mgr, refresh: async () => void (await mgr.refresh()), toast: () => undefined, tools });
    const projectId = mgr.list.find((p) => p.root)!.id;
    const stale = await others.stale(projectId, 'conductor');
    expect(stale.map((s) => s.name)).toEqual(['medan']);
    const all = mgr.list.find((p) => p.root)!.workspaces;
    expect(await others.cleanUp(projectId, all.filter((w) => w.external).map((w) => w.id))).toEqual({ removed: 1, kept: 1 });
    expect(existsSync(live)).toBe(true);
    expect(existsSync(archived)).toBe(false);
  });
});

describe('setting a folder aside to delete it', () => {
  const held = (code: string, times: number) => {
    const calls: string[] = [];
    const move = async (from: unknown, to: unknown): Promise<void> => {
      calls.push(`${from}->${to}`);
      if (calls.length <= times) throw Object.assign(new Error(code), { code });
    };
    return { calls, move: move as never };
  };

  it('on Windows, tries again while the folder is held a moment (Defender reading files just made)', async () => {
    const { calls, move } = held('EPERM', 2);
    await renameFolder('a', 'b', { platform: 'win32', move });
    expect(calls).toEqual(['a->b', 'a->b', 'a->b']);
  });

  it('gives up once it stays held, and never waits on another error or elsewhere', async () => {
    const stuck = held('EBUSY', 99);
    await expect(renameFolder('a', 'b', { platform: 'win32', move: stuck.move })).rejects.toThrow('EBUSY');
    expect(stuck.calls).toHaveLength(6);
    const gone = held('ENOENT', 99);
    await expect(renameFolder('a', 'b', { platform: 'win32', move: gone.move })).rejects.toThrow('ENOENT');
    expect(gone.calls).toHaveLength(1);
    const mac = held('EPERM', 99);
    await expect(renameFolder('a', 'b', { platform: 'darwin', move: mac.move })).rejects.toThrow('EPERM');
    expect(mac.calls).toHaveLength(1);
  });
});
