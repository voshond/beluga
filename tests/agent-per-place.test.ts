import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resumeFor } from '../src/agent/session-carry.js';
import { routedBackend } from '../src/agent/runtime/router.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController } from '../src/core/workspace-controller.js';
import type { AgentRef } from '../src/protocol.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { screenOver } from './helpers.js';

/** BLG-445: each place carries its agent, and a session id only ever goes back to the runtime that made it. */

const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5-codex' };
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

describe('resumeFor', () => {
  it('resumes only the runtime that made the session', () => {
    expect(resumeFor({ sessionId: 'c-1' }, 'claude')).toEqual({ resume: 'c-1', forkSession: false });
    expect(resumeFor({ sessionId: 'c-1' }, 'codex')).toEqual({ forkSession: false });
    expect(resumeFor({ sessionId: 'x-1', sessionRuntime: 'codex' }, 'codex')).toEqual({ resume: 'x-1', forkSession: false });
    expect(resumeFor({ sessionId: 'x-1', sessionRuntime: 'codex' }, 'claude')).toEqual({ forkSession: false });
    expect(resumeFor({ forkFromSession: 'x-0', sessionRuntime: 'codex' }, 'claude')).toEqual({ forkSession: false });
    expect(resumeFor({ forkFromSession: 'c-0' }, 'claude')).toEqual({ resume: 'c-0', forkSession: true });
  });

  it("gives a Claude Code conversation found outside Beluga to Claude only, and never over a stored one", () => {
    expect(resumeFor({}, 'claude', 'found')).toEqual({ resume: 'found', forkSession: false });
    expect(resumeFor({}, 'codex', 'found')).toEqual({ forkSession: false });
    expect(resumeFor({ sessionId: 'x-1', sessionRuntime: 'codex' }, 'claude', 'found')).toEqual({ forkSession: false });
  });
});

describe('a place and its agent', () => {
  let ctl: WorkspaceController;
  let manager: WorkspaceManager;
  let wsStore: WorkspaceStore;
  let store: Store;

  beforeEach(async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-agent-place-')));
    const repo = path.join(base, 'code', 'app');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', path.join(base, 'app.git')], { stdio: 'pipe' });
    sh(repo, 'init', '-b', 'main');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-m', 'init');
    sh(repo, 'remote', 'add', 'origin', path.join(base, 'app.git'));
    sh(repo, 'push', '-u', 'origin', 'main');
    sh(repo, 'remote', 'set-head', 'origin', 'main');
    wsStore = new WorkspaceStore(path.join(base, 'home'));
    wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    store = new Store(initialState('room'));
    manager = new WorkspaceManager(wsStore);
    ctl = new WorkspaceController({ manager, store, shares: new ShareService([]), selfId: () => 'me', toast: () => undefined, intend: screenOver(store).intend, askClaude: () => undefined, claudeHome: path.join(base, 'claude') });
    await ctl.refresh();
  });

  const projectId = () => store.getState().projects.find((p) => p.root)!.id;

  it('makes a chat with an agent, which every run uses, and which persists (BLG-83)', async () => {
    const chat = (await ctl.newChat('chats', 'chat with codex', undefined, { agent: CODEX }))!;
    expect(ctl.agentIn(`ws:${chat.id}`)).toMatchObject({ runtime: 'codex', label: 'Codex' });
    const again = new WorkspaceManager(wsStore);
    await again.refresh();
    expect(again.find(chat.id)).toMatchObject({ agent: { runtime: 'codex', label: 'Codex' }, model: 'gpt-5-codex' });
    const plain = (await ctl.newChat('chats', 'plain chat'))!;
    expect(ctl.agentIn(`ws:${plain.id}`)).toBeUndefined();
  });

  it('makes a worktree with an agent, which every run from it uses, and which persists', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'codex-one', { quiet: true, agent: CODEX }))!;
    expect(ctl.place(`ws:${ws.id}`)).toMatchObject({ agent: CODEX, model: 'gpt-5-codex', resume: undefined });
    // A fresh manager reads it back from disk.
    const again = new WorkspaceManager(wsStore);
    await again.refresh();
    expect(again.find(ws.id)).toMatchObject({ agent: { runtime: 'codex', label: 'Codex' }, model: 'gpt-5-codex' });
    const plain = (await ctl.newWorktree(projectId(), 'plain', { quiet: true }))!;
    expect(ctl.place(`ws:${plain.id}`)?.agent).toBeUndefined();
  });

  it("never gives one runtime's session id to another", async () => {
    const ws = (await ctl.newWorktree(projectId(), 'switch', { quiet: true }))!;
    const ch = `ws:${ws.id}`;
    ctl.place(ch)!.onSession('claude-session');
    expect(ctl.place(ch)?.resume).toBe('claude-session');
    manager.setAgent(ws.id, CODEX);
    expect(ctl.place(ch)).toMatchObject({ agent: CODEX, resume: undefined, forkSession: false });
    ctl.place(ch)!.onSession('codex-thread');
    expect(manager.find(ws.id)).toMatchObject({ sessionId: 'codex-thread', sessionRuntime: 'codex' });
    expect(ctl.place(ch)?.resume).toBe('codex-thread');
    // Back to Claude: the Codex thread is not Claude's to resume.
    manager.setAgent(ws.id, undefined);
    expect(ctl.place(ch)?.resume).toBeUndefined();
  });

  it('a same-runtime model change keeps the conversation (BLG-447 regression)', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'models', { quiet: true }))!;
    const ch = `ws:${ws.id}`;
    ctl.place(ch)!.onSession('claude-session');
    manager.setModel(ws.id, 'opus');
    expect(ctl.place(ch)).toMatchObject({ model: 'opus', resume: 'claude-session' });
    manager.setAgent(ws.id, { runtime: 'claude', label: 'Claude', model: 'haiku' });
    expect(ctl.place(ch)).toMatchObject({ model: 'haiku', resume: 'claude-session', agent: { runtime: 'claude', model: 'haiku' } });
  });

  it('a fork keeps its agent, and its session under that runtime', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'src', { quiet: true, agent: CODEX }))!;
    ctl.place(`ws:${ws.id}`)!.onSession('codex-thread');
    const fork = await manager.fork(ws.id, 'fork');
    expect(ctl.place(`ws:${fork.id}`)).toMatchObject({ agent: CODEX, resume: 'codex-thread', forkSession: true });
  });

  it('runs two worktrees on two runtimes at the same time', async () => {
    const a = (await ctl.newWorktree(projectId(), 'on-claude', { quiet: true }))!;
    const b = (await ctl.newWorktree(projectId(), 'on-codex', { quiet: true, agent: CODEX }))!;
    ctl.place(`ws:${a.id}`)!.onSession('claude-session');
    ctl.place(`ws:${b.id}`)!.onSession('codex-thread');
    const seen: Array<{ runtime: string; cwd?: string; resume?: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = (runtime: string): AgentBackend => ({
      run: async (input: AgentRunInput) => {
        seen.push({ runtime, cwd: input.place?.cwd, resume: input.place?.resume });
        await gate; // both are mid-turn together
        return `${runtime} done`;
      },
      nameTask: async () => `${runtime}-name`,
    });
    const backend = routedBackend(fake('claude'), 'claude', (id) => (id === 'codex' ? fake('codex') : undefined));
    const runs = [backend.run({ prompt: 'a', place: ctl.place(`ws:${a.id}`)! } as AgentRunInput), backend.run({ prompt: 'b', place: ctl.place(`ws:${b.id}`)! } as AgentRunInput)];
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([
      { runtime: 'claude', cwd: a.path, resume: 'claude-session' },
      { runtime: 'codex', cwd: b.path, resume: 'codex-thread' },
    ]);
    release();
    expect(await Promise.all(runs)).toEqual(['claude done', 'codex done']);
    // Side calls stay with your default agent.
    expect(await backend.nameTask?.('x')).toBe('claude-name');
    // A runtime this Mac doesn't run says so instead of falling back to another.
    await expect(backend.run({ prompt: 'c', place: { ...ctl.place(`ws:${a.id}`)!, agent: { runtime: 'local', label: 'Local model' } } } as AgentRunInput)).rejects.toThrow(/Local model isn't set up/);
  });
});
