import { describe, expect, it } from 'vitest';
import type { MachineView } from '../src/machines/machines.js';
import { type RemoteSnapshot, type RemoteSource, onlyItsWork, remoteDashboards, remoteOnlyProjects, remotePlans, remoteSentinels, remoteTasks, remoteWorkIn, shortName, whereLine } from '../packages/mac/src/machines/remote-work.js';
import { matchRemoteChats, sidebarResults } from '../packages/mac/src/layout/sidebar-search-model.js';

/**
 * Every computer in one sidebar and every list (BLG-785): each computer's worktrees and chats under
 * the project of the same name, its other projects, plans, sentinels, tasks and dashboards, all
 * tagged; an offline computer's kept, greyed, with when it was seen; and search finding them.
 */

const NOW = 1_800_000_000_000;
const machine = (id: string, name: string, over: Partial<MachineView> = {}): MachineView => ({ id, name, platform: 'linux', version: '0.6.2', pairedAt: 0, status: 'online', skew: 'same', ...over }) as MachineView;
const box = machine('a'.repeat(16), 'build-box');
const mini = machine('b'.repeat(16), 'Mac mini at home', { status: 'offline', lastSeen: NOW - 5 * 60_000 });

const snap: RemoteSnapshot = {
  projects: [
    { id: 'p1', name: 'bob-api', workspaces: [{ id: 'm', name: 'main', kind: 'main' }, { id: 'w1', name: 'retries', kind: 'worktree' }, { id: 'c1', name: 'How do deploys work?', kind: 'chat' }] },
    { id: 'p2', name: 'scraper', workspaces: [{ id: 'w2', name: 'nightly', kind: 'worktree' }] },
  ],
  plans: [{ id: 'pl1', title: 'Card checkout', projectId: 'p1', status: 'running' }],
  sentinels: [{ id: 's1', name: 'Watch the web', projectId: 'p2', paused: true }],
  tasks: [{ id: 't1', key: 'BOB-9', title: 'Rate-limit login', status: 'todo', projectId: 'p1' }],
  dashboards: [{ id: 'd1', name: 'Signups' }],
};
const sources: RemoteSource[] = [
  { machine: box, snapshot: snap, live: true, at: NOW },
  { machine: mini, snapshot: { ...snap, projects: [{ id: 'p9', name: 'bob-api', workspaces: [{ id: 'w9', name: 'old-branch', kind: 'worktree' }] }] }, live: false, at: NOW - 10 * 60_000 },
];

describe('every computer in the sidebar', () => {
  it('lists a computer’s worktrees and chats under the project of the same name, never its main folder', () => {
    const rows = remoteWorkIn('bob-api', sources);
    expect(rows.map((r) => `${r.item.name}@${r.machine.name}${r.offline ? ' (offline)' : ''}`)).toEqual(['retries@build-box', 'How do deploys work?@build-box', 'old-branch@Mac mini at home (offline)']);
  });

  it('a computer’s projects this Mac doesn’t have show on their own', () => {
    expect(remoteOnlyProjects(new Set(['bob-api']), sources).map((t) => `${t.item.name}@${t.machine.name}`)).toEqual(['scraper@build-box']);
  });

  it('an offline computer’s items stay and say when it was seen', () => {
    const [, , old] = remoteWorkIn('bob-api', sources);
    expect(whereLine(old!, NOW)).toBe('Mac mini at home · offline, seen 5 min ago');
    expect(whereLine(remoteWorkIn('bob-api', sources)[0]!, NOW)).toBe('build-box');
  });

  it('tags with a short name', () => {
    expect(shortName('Mac mini at home')).toBe('Mac mini');
    expect(shortName('build-box')).toBe('build-box');
    expect(shortName('a-very-long-computer-name')).toBe('a-very-long-co');
  });
});

describe('every list', () => {
  it('plans, sentinels, tasks and dashboards come tagged, with their project there', () => {
    expect(remotePlans([sources[0]!]).map((t) => [t.item.title, t.item.project, t.machine.name])).toEqual([['Card checkout', 'bob-api', 'build-box']]);
    expect(remoteSentinels([sources[0]!]).map((t) => [t.item.name, t.item.project, t.item.paused])).toEqual([['Watch the web', 'scraper', true]]);
    expect(remoteTasks([sources[0]!]).map((t) => [t.item.key, t.item.project])).toEqual([['BOB-9', 'bob-api']]);
    expect(remoteDashboards([sources[0]!]).map((t) => t.item.name)).toEqual(['Signups']);
  });

  it('a demo computer is only the work it says it runs', () => {
    const only = onlyItsWork(snap, [{ channel: 'ws:w1' }]);
    expect(only.projects).toEqual([{ id: 'p1', name: 'bob-api', workspaces: [{ id: 'w1', name: 'retries', kind: 'worktree' }] }]);
    expect(only.plans).toEqual([]);
  });
});

describe('search finds chats on every computer', () => {
  it('by name or project, tagged with the computer', () => {
    const found = matchRemoteChats('retr', sources);
    expect(found).toEqual([{ machine: { id: box.id, name: 'build-box' }, id: 'w1', label: 'retries', detail: 'bob-api · build-box' }]);
    expect(matchRemoteChats('bob', sources).map((m) => m.label)).toEqual(['retries', 'How do deploys work?', 'old-branch']);
  });

  it('lists them after this Mac’s chats, and their messages after this Mac’s', () => {
    const hit = { channel: 'ws:w1', place: 'retries', who: 'you', text: 'retry the webhook', at: 0, ts: 1 };
    const results = sidebarResults('retry', [], { query: 'retry', hits: [] }, { chats: matchRemoteChats('retries', sources), messages: [{ machine: { id: box.id, name: 'build-box' }, id: 'w1', label: 'retries', detail: 'build-box', hit }] });
    expect(results.map((r) => r.type)).toEqual(['remote', 'remote', 'all']);
  });
});
