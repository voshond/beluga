import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockBackend } from '../src/agent/mock.js';
import { askForTask } from '../src/core/board/launch.js';
import { startPrompt } from '../src/core/board/work.js';
import { type FilterContext, MAX_CONTENT, cleanText, pickOutgoing } from '../src/core/honcho/filter.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { type Action, Store, initialState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { PeerClient } from '../src/net/peer-client.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { attach } from './helpers.js';
import { brief, setup, until } from './sentinel-fakes.js';

/** BLG-111: what Beluga writes for you (task briefs, sentinel runs) and huge pastes stay out of Honcho as your words. */

const SELF = 'me';
const NOW = new Date(2026, 10, 23, 9).getTime();

type ChatAction = Extract<Action, { type: 'chat' }>;

const ws = (id: string): Workspace => ({ id, projectId: 'p1', projectRoot: '/code/app', name: `task ${id}`, path: `/wt/${id}`, kind: 'worktree', branch: `beluga/${id}`, createdAt: NOW, external: false });
const project: Project = { id: 'p1', name: 'app', root: '/code/app', base: 'origin/main', workspaces: [ws('a')] };

const ctx = (): FilterContext => {
  const store = new Store(initialState('test', 'ask'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true });
  store.dispatch({ type: 'projects', projects: [project] });
  return { state: store.getState(), excluded: [], since: 0, sharedWith: () => false };
};

const mine = (text: string, more: Partial<ChatAction> = {}): ChatAction => ({ type: 'chat', id: `m-${text.length}`, from: SELF, text, ts: NOW, byAgent: false, channel: 'ws:a', ...more });

describe('the filter', () => {
  it('sends what you typed as you', () => {
    expect(pickOutgoing(mine('fix the login'), ctx())).toMatchObject({ peer: { id: 'user', role: 'user' }, content: 'fix the login' });
  });

  it('leaves out a task brief and a sentinel run Beluga wrote for you', () => {
    expect(pickOutgoing(mine('Work on BLG-1: Fix it.\n\nDone means:\n- [ ] it works', { written: 'task' }), ctx())).toBeUndefined();
    expect(pickOutgoing(mine('Brief for app on Mon 23 Nov 2026', { written: 'sentinel' }), ctx())).toBeUndefined();
  });

  it('cuts a long paste down to its start, saying how much was left out', () => {
    const paste = `Look at this log\n${'x'.repeat(MAX_CONTENT * 3)}`;
    const sent = pickOutgoing(mine(paste), ctx())!;
    expect(sent.content.length).toBeLessThan(MAX_CONTENT + 60);
    expect(sent.content.startsWith('Look at this log\nxxx')).toBe(true);
    expect(sent.content).toMatch(new RegExp(`\\[… ${paste.length - MAX_CONTENT} more characters left out\\]$`));
    expect(cleanText('short')).toBe('short');
    expect(cleanText('y'.repeat(MAX_CONTENT))).toBe('y'.repeat(MAX_CONTENT));
  });

  it('cuts a long answer from your agent the same way', () => {
    const report = 'z'.repeat(MAX_CONTENT + 500);
    const sent = pickOutgoing({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'done', text: report, ts: NOW, channel: 'ws:a' }, ctx())!;
    expect(sent.content).toContain('[… 500 more characters left out]');
  });
});

describe('marked where Beluga writes it', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  const session = async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-honcho-written-'));
    const files = new WorkspaceStore(home);
    files.saveConfig({ roots: [], projects: [], hidden: [] });
    const store = new Store(initialState('demo'));
    const s = new Session({
      client: new PeerClient({ url: 'ws://127.0.0.1:1', keys: deriveKeys(generateSecret()), profile: { name: 'kay', shares: [], agent: true } }),
      store,
      shares: new ShareService([]),
      workspaces: new WorkspaceManager(files),
      agentCwd: home,
      createAgent: (bridge) => ({ ...createMockBackend(bridge, 0), run: async () => 'ok' }),
    });
    const client = attach(s);
    cleanups.push(async () => {
      client.close();
      await s.stop();
      rmSync(home, { recursive: true, force: true });
    });
    await s.workspaces!.refresh();
    const chat = (await s.workspaces!.newChat('chats', 'Work', undefined, { quiet: true }))!;
    const chats: ChatAction[] = [];
    store.onAction((a) => void (a.type === 'chat' && chats.push(a)));
    return { s, store, channel: `ws:${chat.id}`, chats };
  };

  it('a task brief is said in the chat as yours, marked as written by its task', async () => {
    const { s, store, channel, chats } = await session();
    const issue = { key: 'BLG-1', title: 'Fix it', brief: { goal: 'It works', acceptance: '- [ ] it works' } } as Parameters<typeof startPrompt>[0];
    askForTask(s)(startPrompt(issue), channel);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ from: s.selfId, written: 'task', text: expect.stringContaining('Work on BLG-1') });
    expect(store.getState().log.find((l) => l.type === 'chat' && l.channel === channel)).toMatchObject({ written: 'task' });
  });

  it('what you type has no mark', async () => {
    const { s, channel, chats } = await session();
    s.askOwnClaude('fix the login', channel);
    expect(chats).toHaveLength(1);
    expect(chats[0]!.written).toBeUndefined();
  });

  it('the shown line of a task brief carries the mark too', async () => {
    const { s, channel, chats } = await session();
    const asked = vi.spyOn(s, 'askOwnClaude');
    askForTask(s)('the whole issue and its instructions', channel, 'Work on issue #12');
    expect(asked).toHaveBeenCalledWith('the whole issue and its instructions', channel, false, 'Work on issue #12', undefined, undefined, 'task');
    expect(chats[0]).toMatchObject({ text: 'Work on issue #12', written: 'task' });
  });

  it('a sentinel run asks your Claude as the sentinel', async () => {
    const f = setup();
    f.sentinels.start(f.sentinels.create(brief).id, 'you');
    await until(() => f.asked.length === 1);
    expect(f.asked[0]!.written).toBe('sentinel');
  });
});
