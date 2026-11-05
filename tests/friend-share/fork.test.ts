import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeProjectDir } from '../../src/agent/runtime/claude/claude-sessions.js';
import { createDemoWorkspaces } from '../../src/demo.js';
import type { SharedFork } from '../../src/core/friend-share-store.js';
import type { LogItem } from '../../src/core/store.js';
import { type Crowd, LOSES_A_MESSAGE_ON_WINDOWS, SLOW, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Mac, mac } from './helpers.js';

/** BLG-312: a friend forks one of your shared worktrees to their own Mac, changes, Scratch, conversation and Claude's session with it. */

let net: Crowd | undefined;
const macs: Mac[] = [];
const configBefore = process.env.CLAUDE_CONFIG_DIR;

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
  if (configBefore === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configBefore;
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('forking a friend’s worktree to your Mac', () => {
  it('brings its commits, its uncommitted work, Scratch, the conversation and Claude’s session, never a secret; theirs stays as it was', async () => {
    const claude = mkdtempSync(path.join(os.tmpdir(), 'beluga-fork-claude-'));
    process.env.CLAUDE_CONFIG_DIR = claude;
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const theirs = project.workspaces.find((w) => w.kind === 'worktree' && !w.archived && !w.external && w.branch)!;

    // Ata's worktree as it is now: a changed file, a new one, a secret, Scratch, a conversation and Claude's session.
    const tracked = git(theirs.path, 'ls-files').split('\n').find((f) => !f.startsWith('.'))!;
    writeFileSync(path.join(theirs.path, tracked), 'changed on ata’s Mac\n');
    mkdirSync(path.join(theirs.path, 'notes'), { recursive: true });
    writeFileSync(path.join(theirs.path, 'notes', 'idea.md'), 'not committed yet\n');
    writeFileSync(path.join(theirs.path, '.env'), 'API_KEY=hunter2-very-secret\n');
    mkdirSync(path.join(theirs.path, '.beluga', 'scratch'), { recursive: true });
    writeFileSync(path.join(theirs.path, '.beluga', 'scratch', '01-notes.md'), 'what I found\n');
    const head = git(theirs.path, 'rev-parse', 'HEAD');
    const statusBefore = git(theirs.path, 'status', '--porcelain');
    ata.session.workspaces!.manager.rememberSession(theirs.id, 'sess-fork-1');
    const sessions = path.join(claude, 'projects', encodeProjectDir(theirs.path));
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, 'sess-fork-1.jsonl'), `${JSON.stringify({ type: 'user', text: 'the key is hunter2-very-secret' })}\n`);
    await ata.session.workspaces!.refresh();
    ata.session.sendChat('let’s try the cache first', false, `ws:${theirs.id}`);

    ata.session.sharing.shareWithFriend({ peerId: kay.id, projectId: project.id, role: 'contribute' });
    await settle(() => kay.store.getState().sharedProjects.find((p) => p.id === project.id && p.copy?.state === 'ready'));

    const seen: SharedFork[] = [];
    const off = kay.store.subscribe(() => {
      const f = kay.store.getState().forks[theirs.id];
      if (f && f !== seen.at(-1)) seen.push(f);
    });
    await kay.shares.fork(ata.id, theirs.id, 'my-take');
    const fork = await settle(() => {
      const f = kay.store.getState().forks[theirs.id];
      if (f?.state === 'failed') throw new Error(f.error);
      return f?.state === 'ready' ? f : undefined;
    });
    off();
    const mine = kay.session.workspaces!.manager.find(fork.wsId!)!;
    expect(mine.branch).toBe('beluga/my-take');
    expect(mine.forkFromSession).toBe('sess-fork-1');

    // The commits, and the uncommitted work left uncommitted.
    expect(git(mine.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(path.join(mine.path, tracked), 'utf8')).toBe('changed on ata’s Mac\n');
    expect(readFileSync(path.join(mine.path, 'notes', 'idea.md'), 'utf8')).toBe('not committed yet\n');
    expect(git(mine.path, 'status', '--porcelain')).toContain(tracked);
    // Scratch, the conversation, and Claude's session where Claude Code looks, its secret taken out.
    expect(readFileSync(path.join(mine.path, '.beluga', 'scratch', '01-notes.md'), 'utf8')).toBe('what I found\n');
    const log = kay.session.workspaces!.manager.loadHistory<LogItem>(mine.id);
    expect(log.some((l) => l.type === 'system' && l.text.includes('let’s try the cache first'))).toBe(true);
    expect(log.some((l) => l.type === 'system' && l.text.startsWith('Forked from ata’s'))).toBe(true);
    const session = readFileSync(path.join(claude, 'projects', encodeProjectDir(path.resolve(mine.path)), 'sess-fork-1.jsonl'), 'utf8');
    expect(session).toContain('[secret]');
    expect(session).not.toContain('hunter2');
    // Never a secret, and no setup from a friend kay doesn't fully trust.
    expect(existsSync(path.join(mine.path, '.env'))).toBe(false);
    expect(log.some((l) => l.type === 'system' && l.text.startsWith('Setup didn’t run'))).toBe(true);

    // Ata's worktree is as it was, and ata is told.
    expect(git(theirs.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(theirs.path, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(theirs.path, 'for-each-ref', 'refs/beluga-fork')).toBe('');
    expect(ata.store.getState().log.some((l) => l.type === 'system' && l.channel === `ws:${theirs.id}` && l.text.startsWith('kay forked this worktree'))).toBe(true);

    // How far it got as it came over: from nothing to all of its bytes, with how many files are in it.
    const copying = seen.filter((f) => f.state === 'copying');
    expect(copying[0]!.received).toBe(0);
    expect(copying[0]!.total).toBeGreaterThan(0);
    // The two uncommitted files and Scratch's (the demo's worktree may have more of its own).
    expect(copying[0]!.files).toBeGreaterThanOrEqual(3);
    expect(copying.at(-1)!.received).toBe(copying[0]!.total);
  }, 60_000 * SLOW);

  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('someone who only follows along can’t fork', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay', { workspaces: await createDemoWorkspaces() });
    macs.push(ata, kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    const ws = project.workspaces.find((w) => w.kind === 'worktree' && !w.archived && !w.external)!;
    ata.session.sharing.shareWithFriend({ peerId: kay.id, workspaceId: ws.id, role: 'view' });
    await settle(() => kay.store.getState().sharedProjects[0]);
    await expect(kay.shares.fork(ata.id, ws.id)).rejects.toThrow(/Can work here/);
  }, 30_000 * SLOW);
});
