import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockBackend } from '../src/agent/mock.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { PeerClient } from '../src/net/peer-client.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { attach } from './helpers.js';
import type { Action, AppState } from '../src/core/store.js';
import { type ScreenAction, initialAppState, reduceApp } from '../src/client/screen.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { dockCount, projectTally, signalOf, unreadEntries, workspaceSignal } from '../packages/mac/src/layout/attention-model.js';
import { remindLabel, remindPending, remindTime } from '../src/shared/remind.js';
import { Reminders, reminderNotice } from '../src/core/reminders.js';
import { remindLaterNotice } from '../src/core/notify.js';

/** Quiet while your agent fixes it, and Remind Me Later on a conversation (BLG-748). */

const NOW = new Date(2026, 10, 7, 11, 0).getTime(); // a Saturday, 11:00 local
const HOUR = 3_600_000;

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', branch: 'beluga/w', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over,
});
const project = (...workspaces: Workspace[]): Project => ({ id: 'p1', name: 'api', root: '/p', base: 'origin/main', workspaces });

const apply = (s: AppState, ...actions: Array<Action | ScreenAction>): AppState => actions.reduce<AppState>((st, a) => reduceApp(st, a), s);
const stateWith = (...workspaces: Workspace[]): AppState =>
  apply(initialAppState('room'), { type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [project(...workspaces)] });
const run = (event: 'started' | 'done' | 'awaiting_approval', channel = 'ws:auth'): Action => ({ type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'me', event, text: event === 'done' ? 'Fixed.' : '', ts: 5, channel });
const failing: Action = { type: 'pr', id: 'auth', pr: { number: 1, url: 'u', state: 'OPEN', title: 't', draft: false, checks: 'failing' } };
const overview: ScreenAction = { type: 'view', view: { kind: 'overview' } };
const inAuth: ScreenAction = { type: 'view', view: { kind: 'workspace', id: 'auth', tab: 'chat' } };

afterEach(() => vi.useRealTimers());

describe('failing checks or a conflict while your agent works on them', () => {
  it('reads as working, not as a problem, and is red again if it is still failing when the agent stops', () => {
    const s = apply(stateWith(ws({ id: 'auth', name: 'add-auth' })), overview, failing);
    expect(signalOf(s, 'ws:auth', 'auth')).toMatchObject({ level: 'needs', need: 'checks' });
    // You click Fix in the worktree: your agent starts there.
    const fixing = apply(s, inAuth, run('started'));
    expect(signalOf(fixing, 'ws:auth', 'auth')).toMatchObject({ level: 'working', working: true, tip: 'Your agent is working · Checks failed on its pull request' });
    expect(signalOf(fixing, 'ws:auth', 'auth').need).toBeUndefined();
    const stopped = apply(fixing, run('done'), overview);
    expect(signalOf(stopped, 'ws:auth', 'auth')).toMatchObject({ level: 'needs', need: 'checks' });
  });

  it('does the same for a merge conflict, but an approval still needs you while it works', () => {
    const s = apply(stateWith(ws({ id: 'auth' })), inAuth, { type: 'conflicts', id: 'auth', files: ['a.ts'] }, run('started'));
    expect(signalOf(s, 'ws:auth', 'auth')).toMatchObject({ level: 'working', tip: 'Your agent is working · A merge conflict to resolve' });
    const asks = apply(s, { type: 'approval_add', approval: { id: 'a1', kind: 'tool', title: 'Bash', detail: '', channel: 'ws:auth' } });
    expect(signalOf(asks, 'ws:auth', 'auth')).toMatchObject({ level: 'needs', need: 'approval' });
  });
});

describe('Remind Me Later choices', () => {
  it('reminds you an hour or three on, tomorrow morning, or next Monday morning', () => {
    expect(remindTime('hour', NOW)).toBe(NOW + HOUR);
    expect(remindTime('hours', NOW)).toBe(NOW + 3 * HOUR);
    expect(remindTime('tomorrow', NOW)).toBe(new Date(2026, 10, 8, 8, 0).getTime());
    expect(remindTime('week', NOW)).toBe(new Date(2026, 10, 9, 8, 0).getTime());
    // From a Monday: the Monday after.
    expect(remindTime('week', new Date(2026, 10, 9, 10, 0).getTime())).toBe(new Date(2026, 10, 16, 8, 0).getTime());
  });

  it('says when it reminds you, and nothing once it has', () => {
    expect(remindLabel({ remindAt: NOW + HOUR }, NOW)).toBe('Reminds you at 12:00');
    expect(remindLabel({ remindAt: remindTime('tomorrow', NOW) }, NOW)).toBe('Reminds you tomorrow at 08:00');
    expect(remindLabel({ remindAt: remindTime('week', NOW) }, NOW)).toBe('Reminds you Mon at 08:00');
    expect(remindPending({ remindAt: NOW - 1 }, NOW)).toBe(false);
    expect(remindLabel({ remindAt: NOW - 1 }, NOW)).toBe('');
    expect(remindPending({}, NOW)).toBe(false);
  });
});

describe('a conversation put off till later', () => {
  const later = ws({ id: 'auth', name: 'add-auth', remindAt: NOW + HOUR });
  const news = (s: AppState): AppState => apply(s, overview, run('started'), run('done'), { type: 'chat', id: 'c1', from: 'me', text: 'hm', ts: 6, byAgent: true, channel: 'ws:auth' });

  it('hides its news and failing checks, and leaves the Unread section, tallies and Dock', () => {
    vi.useFakeTimers({ now: NOW });
    const s = apply(news(stateWith(later)), failing);
    expect(workspaceSignal(s, later, NOW)).toMatchObject({ level: 'idle', unread: 0, remindAt: NOW + HOUR, tip: 'Reminds you at 12:00' });
    expect(unreadEntries(s)).toEqual([]);
    expect(projectTally(s, s.projects[0]!)).toMatchObject({ unread: 0, needs: 0 });
    expect(dockCount(s)).toBe(0);
  });

  it('still shows your agent at work and what it asks you', () => {
    vi.useFakeTimers({ now: NOW });
    const s = apply(stateWith(later), overview, run('started'));
    expect(workspaceSignal(s, later, NOW)).toMatchObject({ level: 'working', tip: 'Your agent is working · Reminds you at 12:00' });
    const asks = apply(s, run('awaiting_approval'));
    expect(workspaceSignal(asks, later, NOW)).toMatchObject({ level: 'needs', need: 'approval', remindAt: NOW + HOUR });
    expect(unreadEntries(asks)).toHaveLength(1);
  });

  it('shows it all again once its time has come', () => {
    const s = news(stateWith(later));
    expect(workspaceSignal(s, later, NOW + 2 * HOUR)).toMatchObject({ level: 'unread' });
  });

  it('keeps its desktop notices quiet meanwhile, but never your agent asking', () => {
    const state = { projects: [project(later, ws({ id: 'other' }))] };
    expect(remindLaterNotice(state, { kind: 'problems', channel: 'ws:auth' }, NOW)).toBe(true);
    expect(remindLaterNotice(state, { kind: 'done', channel: 'ws:auth' }, NOW)).toBe(true);
    expect(remindLaterNotice(state, { kind: 'needsYou', channel: 'ws:auth' }, NOW)).toBe(false);
    expect(remindLaterNotice(state, { kind: 'done', channel: 'ws:other' }, NOW)).toBe(false);
    expect(remindLaterNotice(state, { kind: 'done', channel: 'ws:auth' }, NOW + 2 * HOUR)).toBe(false);
  });

  it('reminds you with what waits there', () => {
    const s = apply(news(stateWith(later)), failing);
    expect(reminderNotice(s, later)).toMatchObject({ kind: 'needsYou', title: 'Reminder: add-auth', body: expect.stringMatching(/^Checks failed on its pull request · \d+ new messages?$/), channel: 'ws:auth' });
    expect(reminderNotice(stateWith(later), later).body).toBe('You asked to be reminded about it');
  });
});

describe('the reminder clock', () => {
  it('hands over one that is due at once, and the next when its time comes', () => {
    vi.useFakeTimers({ now: NOW });
    let projects = [project(ws({ id: 'due', remindAt: NOW - 1 }), ws({ id: 'later', remindAt: NOW + HOUR }), ws({ id: 'shown' }))];
    const reminded: string[][] = [];
    const clock = new Reminders({
      projects: () => projects,
      due: (list) => {
        const ids = list.map((w) => w.id);
        reminded.push(ids);
        projects = projects.map((p) => ({ ...p, workspaces: p.workspaces.map((w) => (ids.includes(w.id) ? { ...w, remindAt: undefined } : w)) }));
      },
    });
    clock.arm();
    expect(reminded).toEqual([['due']]);
    vi.advanceTimersByTime(HOUR - 1);
    expect(reminded).toEqual([['due']]);
    vi.advanceTimersByTime(1);
    expect(reminded).toEqual([['due'], ['later']]);
    clock.stop();
  });
});

describe('Remind Me Later through the daemon', () => {
  it('saves the time, publishes it, shows it again on request, reminds you when due, and refuses a time gone by', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-remind-'));
    const files = new WorkspaceStore(home);
    files.saveConfig({ roots: [], projects: [], hidden: [] });
    const manager = new WorkspaceManager(files);
    const store = new Store(initialState('demo'));
    const session = new Session({
      client: new PeerClient({ url: 'ws://127.0.0.1:1', keys: deriveKeys(generateSecret()), profile: { name: 'kay', shares: [], agent: true } }),
      store,
      shares: new ShareService([]),
      workspaces: manager,
      agentCwd: home,
      createAgent: (bridge) => createMockBackend(bridge, 0),
    });
    const client = attach(session);
    try {
      const controller = session.workspaces!;
      await controller.refresh();
      const chat = (await controller.newChat('chats', 'Later', undefined, { quiet: true }))!;
      const published = () => store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === chat.id);
      const reminders = () => store.getState().inbox.filter((n) => n.title === 'Reminder: Later');
      const at = Date.now() + HOUR;
      await client.api.workspaces.remindLater(chat.id, at);
      expect(published()?.remindAt).toBe(at);
      // Saved with the workspace: still put off after a restart.
      expect(new WorkspaceStore(home).loadRecords().find((r) => r.id === chat.id)?.remindAt).toBe(at);
      // Show Again Now: null arrives over the socket as left out. No reminder for that.
      await client.api.workspaces.remindLater(chat.id, null);
      expect(published()?.remindAt).toBeUndefined();
      expect(reminders()).toEqual([]);
      // Its time came (here, while Beluga was closed): shown again, and one reminder.
      manager.setRemindAt(chat.id, Date.now() - 1);
      await controller.refresh();
      expect(published()?.remindAt).toBeUndefined();
      expect(reminders()).toHaveLength(1);
      await controller.refresh();
      expect(reminders()).toHaveLength(1);
      await expect(client.api.workspaces.remindLater(chat.id, Date.now() - 1000)).rejects.toThrow('still ahead');
      await expect(client.api.workspaces.remindLater('missing', at)).rejects.toThrow('isn’t there');
    } finally {
      client.close();
      await session.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
