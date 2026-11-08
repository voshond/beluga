import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../src/agent/types.js';
import { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { triageFacts } from '../src/core/triage/facts.js';
import { categoryOf } from '../src/core/triage/model.js';
import { TriageService } from '../src/core/triage/service.js';
import { createDemoWorkspaces } from '../src/demo.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import type { WorkspaceManager } from '../src/workspaces/manager.js';
import { waitFor } from './helpers.js';

/**
 * Two people in one real room share one chat. Each has a daemon's parts of their own: a Session, a
 * TriageService and a triage file. A category belongs to one person, and it never goes on the wire.
 */

const keys = deriveKeys(generateSecret());
const SETTLED_KEYS = /triage|settled|snoozed|backAt|holdIdle/;
let hub: Hub;
let dir: string;
let demo: WorkspaceManager;
let turn: { release?: () => void };
const stops: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  demo = await createDemoWorkspaces();
}, 120_000);

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'triage-two-')));
  hub = await startHub({ keys });
  turn = {};
});

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

function person(name: string, workspaces?: WorkspaceManager) {
  const shares = new ShareService([]);
  const store = new Store(initialState('test', 'ask', { chatCategories: true }));
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name, shares: shares.infos, agent: true }, reconnect: false });
  const wire = vi.spyOn(client, 'send');
  const session = new Session({
    client,
    store,
    shares,
    agentCwd: dir,
    requestTimeoutMs: 4000,
    agentTimeoutMs: 8000,
    zoom: async () => ({ ok: true, message: '' }),
    copy: async () => undefined,
    ...(workspaces ? { workspaces } : {}),
    createAgent: (): AgentBackend => ({
      run: () =>
        new Promise((resolve) => {
          turn.release = () => resolve('done');
        }),
    }),
  });
  session.start();
  const file = path.join(dir, `${name}-triage.json`);
  const triage = new TriageService({ store, file, notify: () => undefined, history: () => [] });
  stops.push(() => session.stop());
  stops.push(() => triage.stop());
  const categoryIn = (channel: string) => categoryOf(store.getState().triage[channel], triageFacts(store.getState(), channel));
  return { session, store, triage, file, wire, categoryIn };
}

type Person = ReturnType<typeof person>;

async function sharedChat(owner: Person, guest: Person): Promise<string> {
  await waitFor(() => owner.store.getState().peers.length === 2 && guest.store.getState().peers.length === 2);
  await owner.session.workspaces!.refresh();
  const ws = await waitFor(() =>
    owner.store
      .getState()
      .projects.flatMap((p) => p.workspaces)
      .find((w) => w.kind === 'worktree' && !w.archived),
  );
  owner.session.sharing.invite(ws.id, guest.session.selfId, 'contribute', { quiet: true });
  await waitFor(() => guest.store.getState().shared.some((w) => w.id === ws.id));
  return `ws:${ws.id}`;
}

describe('two people in one shared chat', () => {
  it("one person's settle and snooze change nothing for the other, and neither goes on the wire", async () => {
    const owner = person('kay', demo);
    const guest = person('bob');
    const channel = await sharedChat(owner, guest);
    expect(owner.categoryIn(channel)).toBe('active');
    expect(guest.categoryIn(channel)).toBe('active');

    owner.triage.settle(channel);
    expect(owner.categoryIn(channel)).toBe('settled');
    expect(guest.categoryIn(channel)).toBe('active');
    expect(guest.store.getState().triage[channel]?.settled).toBeUndefined();

    guest.triage.snooze(channel, Date.now() + 60_000);
    expect(guest.categoryIn(channel)).toBe('snoozed');
    expect(owner.categoryIn(channel)).toBe('settled');
    expect(owner.store.getState().triage[channel]?.snoozed).toBeUndefined();

    // A message crosses the room after both changes, so anything a change had sent is out by now.
    owner.session.submit('still there?', { channel });
    await waitFor(() => guest.store.getState().log.some((l) => l.type === 'chat' && l.text === 'still there?'));
    for (const who of [owner, guest]) {
      const sent = who.wire.mock.calls.map(([body]) => JSON.stringify(body));
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.filter((frame) => SETTLED_KEYS.test(frame))).toEqual([]);
    }
  });

  it("a message moves the other person's Settled chat by that person's own rules", async () => {
    const owner = person('kay', demo);
    const guest = person('bob');
    const channel = await sharedChat(owner, guest);
    owner.triage.settle(channel);
    guest.triage.settle(channel);

    guest.session.submit('one more thing', { channel });
    await waitFor(() => owner.store.getState().log.some((l) => l.type === 'chat' && l.text === 'one more thing'));
    // A guest who may contribute talks to the owner's agent, so the owner's chat can already be working.
    expect(['active', 'working']).toContain(owner.categoryIn(channel));
    expect(['active', 'working']).toContain(guest.categoryIn(channel));
    expect(owner.store.getState().triage[channel]?.settled).toBeUndefined();
    expect(guest.store.getState().triage[channel]?.settled).toBeUndefined();
  });

  it('each person saves only their own category, in their own file', async () => {
    const owner = person('kay', demo);
    const guest = person('bob');
    const channel = await sharedChat(owner, guest);
    owner.triage.settle(channel);
    guest.triage.snooze(channel, Date.now() + 60_000);
    await waitFor(() => existsSync(owner.file) && existsSync(guest.file), 4000);
    const saved = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { chats: Record<string, { settled?: unknown; snoozed?: unknown; shared?: true }> }).chats[channel];
    expect(saved(owner.file)?.settled).toBeDefined();
    expect(saved(owner.file)?.snoozed).toBeUndefined();
    expect(saved(guest.file)?.snoozed).toBeDefined();
    expect(saved(guest.file)?.settled).toBeUndefined();
    expect(saved(guest.file)?.shared).toBe(true);
  });

  it('Working is a fact: a running turn shows for both people', async () => {
    const owner = person('kay', demo);
    const guest = person('bob');
    const channel = await sharedChat(owner, guest);
    owner.session.askOwnClaude('do it', channel);
    await waitFor(() => owner.categoryIn(channel) === 'working');
    await waitFor(() => guest.categoryIn(channel) === 'working');
    (await waitFor(() => turn.release))();
    await waitFor(() => owner.categoryIn(channel) === 'active');
    await waitFor(() => guest.categoryIn(channel) === 'active');
  });
});
