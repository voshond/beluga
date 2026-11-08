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
import { remindLabel, remindPending, remindPresets, remindTime } from '../src/shared/remind.js';
import { remindLaterNotice } from '../src/core/notify.js';
import { launchTriage } from '../src/core/triage/launch.js';

/** Quiet while your agent fixes it, and Remind Me Later on a conversation (BLG-748, kept in the triage records since BLG-770). */

const NOW = new Date(2026, 10, 7, 11, 0).getTime(); // a Saturday, 11:00 local
const HOUR = 3_600_000;

const ws = (over: Partial<Workspace>): Workspace => ({
  id: 'w', projectRoot: '/p', name: 'w', path: '/wt/w', kind: 'worktree', branch: 'beluga/w', base: 'origin/main',
  createdAt: 1, projectId: 'p1', external: false, status: { changed: 0, ahead: 0, behind: 0 }, ...over,
});
const project = (...workspaces: Workspace[]): Project => ({ id: 'p1', name: 'api', root: '/p', base: 'origin/main', workspaces });

const apply = (s: AppState, ...actions: Array<Action | ScreenAction>): AppState => actions.reduce<AppState>((st, a) => reduceApp(st, a), s);
const stateOf = (...workspaces: Workspace[]): AppState =>
  apply(initialAppState('room'), { type: 'welcome', self: { peerId: 'me', name: 'kay', agent: true, shares: [] } }, { type: 'projects', projects: [project(...workspaces)] });
const run = (event: 'started' | 'done' | 'awaiting_approval', channel = 'ws:auth'): Action => ({ type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'me', event, text: event === 'done' ? 'Fixed.' : '', ts: 5, channel });
const failing: Action = { type: 'pr', id: 'auth', pr: { number: 1, url: 'u', state: 'OPEN', title: 't', draft: false, checks: 'failing' } };
const overview: ScreenAction = { type: 'view', view: { kind: 'overview' } };
const inAuth: ScreenAction = { type: 'view', view: { kind: 'workspace', id: 'auth', tab: 'chat' } };

afterEach(() => vi.useRealTimers());

describe('failing checks or a conflict while your agent works on them', () => {
  it('reads as working, not as a problem, and is red again if it is still failing when the agent stops', () => {
    const s = apply(stateOf(ws({ id: 'auth', name: 'add-auth' })), overview, failing);
    expect(signalOf(s, 'ws:auth', 'auth')).toMatchObject({ level: 'needs', need: 'checks' });
    // You click Fix in the worktree: your agent starts there.
    const fixing = apply(s, inAuth, run('started'));
    expect(signalOf(fixing, 'ws:auth', 'auth')).toMatchObject({ level: 'working', working: true, tip: 'Your agent is working · Checks failed on its pull request' });
    expect(signalOf(fixing, 'ws:auth', 'auth').need).toBeUndefined();
    const stopped = apply(fixing, run('done'), overview);
    expect(signalOf(stopped, 'ws:auth', 'auth')).toMatchObject({ level: 'needs', need: 'checks' });
  });

  it('does the same for a merge conflict, but an approval still needs you while it works', () => {
    const s = apply(stateOf(ws({ id: 'auth' })), inAuth, { type: 'conflicts', id: 'auth', files: ['a.ts'] }, run('started'));
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

  it('crosses a month and a year end', () => {
    const eve = new Date(2026, 11, 31, 23, 30).getTime();
    expect(remindTime('hour', eve)).toBe(new Date(2027, 0, 1, 0, 30).getTime());
    expect(remindTime('tomorrow', eve)).toBe(new Date(2027, 0, 1, 8, 0).getTime());
  });

  it('one list for every menu, the Mac and the phone, in order', () => {
    expect(remindPresets(NOW)).toEqual([
      { label: 'In 1 Hour', at: NOW + HOUR },
      { label: 'In 3 Hours', at: NOW + 3 * HOUR },
      { label: 'Tomorrow Morning', at: remindTime('tomorrow', NOW) },
      { label: 'Next Week', at: remindTime('week', NOW) },
    ]);
  });

  it('says when it reminds you, and nothing once it has', () => {
    expect(remindLabel(NOW + HOUR, NOW)).toBe('Reminds you at 12:00');
    expect(remindLabel(remindTime('tomorrow', NOW), NOW)).toBe('Reminds you tomorrow at 08:00');
    expect(remindLabel(remindTime('week', NOW), NOW)).toBe('Reminds you Mon at 08:00');
    expect(remindPending(NOW - 1, NOW)).toBe(false);
    expect(remindLabel(NOW - 1, NOW)).toBe('');
    expect(remindPending(undefined, NOW)).toBe(false);
  });
});

describe('a conversation put off till later', () => {
  const later = ws({ id: 'auth', name: 'add-auth' });
  const putOff = (s: AppState, until = NOW + HOUR): AppState => apply(s, { type: 'triage_set', channel: 'ws:auth', record: { snoozed: { at: NOW, until, seen: [] } } });
  const stateWith = (...workspaces: Workspace[]): AppState => putOff(stateOf(...workspaces));
  const news = (s: AppState): AppState => apply(s, overview, run('started'), run('done'), { type: 'chat', id: 'c1', from: 'me', text: 'hm', ts: 6, byAgent: true, channel: 'ws:auth' });

  it('hides its news and failing checks, and leaves the Unread section, tallies and Dock', () => {
    vi.useFakeTimers({ now: NOW });
    const s = apply(news(stateWith(later)), failing);
    expect(workspaceSignal(s, later, NOW)).toMatchObject({ level: 'idle', unread: 0, remindAt: NOW + HOUR, tip: 'Reminds you at 12:00' });
    expect(unreadEntries(s)).toEqual([]);
    expect(projectTally(s, s.projects[0]!)).toMatchObject({ unread: 0, needs: 0 });
    expect(dockCount(s)).toBe(0);
  });

  it('still shows your agent at work, and anything it asks you after', () => {
    vi.useFakeTimers({ now: NOW });
    const s = apply(stateWith(later), overview, run('started'));
    expect(workspaceSignal(s, later, NOW)).toMatchObject({ level: 'working', tip: 'Your agent is working · Reminds you at 12:00' });
    // Asking you something new ends the wait (the daemon wakes it): it shows as usual.
    const asks = apply(s, run('awaiting_approval'));
    expect(workspaceSignal(asks, later, NOW)).toMatchObject({ level: 'needs', need: 'approval' });
    expect(workspaceSignal(asks, later, NOW).remindAt).toBeUndefined();
    expect(unreadEntries(asks)).toHaveLength(1);
  });

  it('shows it all again once its time has come', () => {
    const s = news(stateWith(later));
    expect(workspaceSignal(s, later, NOW + 2 * HOUR)).toMatchObject({ level: 'unread' });
  });

  it('keeps its desktop notices quiet meanwhile, but never your agent asking', () => {
    const state = stateWith(later, ws({ id: 'other' }));
    expect(remindLaterNotice(state, { kind: 'problems', channel: 'ws:auth' }, NOW)).toBe(true);
    expect(remindLaterNotice(state, { kind: 'done', channel: 'ws:auth' }, NOW)).toBe(true);
    expect(remindLaterNotice(state, { kind: 'needsYou', channel: 'ws:auth' }, NOW)).toBe(false);
    expect(remindLaterNotice(state, { kind: 'done', channel: 'ws:other' }, NOW)).toBe(false);
    expect(remindLaterNotice(state, { kind: 'done', channel: 'ws:auth' }, NOW + 2 * HOUR)).toBe(false);
  });

});

describe('Remind Me Later through the daemon', () => {
  it('works with the categories off, shows it again on request, carries an old reminder in, and refuses a time gone by', async () => {
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
    const stopTriage = launchTriage({ session, store, demo: true });
    try {
      const controller = session.workspaces!;
      await controller.refresh();
      const chat = (await controller.newChat('chats', 'Later', undefined, { quiet: true }))!;
      const channel = `ws:${chat.id}`;
      const reminders = () => store.getState().inbox.filter((n) => n.title === 'Reminder: Later');
      // With the sidebar categories off (the default), as with them on.
      expect(store.getState().prefs.chatCategories).toBe(false);
      const at = Date.now() + HOUR;
      await client.api.triage.snooze(channel, at);
      expect(store.getState().triage[channel]?.snoozed?.until).toBe(at);
      // Show Again Now: no reminder for that.
      await client.api.triage.wake(channel);
      expect(store.getState().triage[channel]?.snoozed).toBeUndefined();
      expect(reminders()).toEqual([]);
      // Settling still needs the categories.
      await expect(client.api.triage.settle(channel)).rejects.toThrow('Chat categories are off');
      await expect(client.api.triage.snooze(channel, Date.now() - 1000)).rejects.toThrow('future');
      // An old Remind Me Later on the worktree's record (before BLG-770): carried in once, cleared there, and due now: one reminder.
      manager.setRemindAt(chat.id, Date.now() - 1);
      await controller.refresh();
      await vi.waitFor(() => expect(reminders()).toHaveLength(1));
      expect(store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === chat.id)?.remindAt).toBeUndefined();
      expect(new WorkspaceStore(home).loadRecords().find((r) => r.id === chat.id)?.remindAt).toBeUndefined();
      await controller.refresh();
      expect(reminders()).toHaveLength(1);
    } finally {
      stopTriage();
      client.close();
      await session.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
