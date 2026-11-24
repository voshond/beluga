import { mkdtempSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHONE } from '../src/companion/coverage.js';
import { waitingNeeds } from '../src/companion/needs-you.js';
import type { HonchoFetch } from '../src/core/honcho/client.js';
import { HonchoFeed } from '../src/core/honcho/feed.js';
import { CONFIRMED, loadSyncedMemory } from '../src/core/honcho/memory-sync.js';
import { type HonchoNote, Reflection } from '../src/core/memory/reflection.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { Store, initialState } from '../src/core/store.js';

const NOW = new Date(2026, 10, 24, 12).getTime();
const URL = 'http://honcho.test:8000';
const temp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-honcho-memory-'));

type Call = { readonly method: string; readonly url: string; readonly body?: { conclusions?: Array<{ content: string; observer_id: string; observed_id: string }>; filters?: Record<string, string> } };
type Conclusion = { id: string; content: string; level: string; times_derived: number };

const fakeHoncho = (held: Conclusion[] = []) => {
  const calls: Call[] = [];
  let next = 0;
  const fetch: HonchoFetch = (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Call['body']) : undefined;
    calls.push({ method: init.method, url, ...(body ? { body } : {}) });
    const ok = (value: object | null) => Promise.resolve({ ok: true, status: value === null ? 204 : 200, text: async () => (value === null ? '' : JSON.stringify(value)) });
    if (init.method === 'DELETE') return ok(null);
    if (url.endsWith('/conclusions')) return ok((body?.conclusions ?? []).map((c) => ({ id: `c${++next}`, content: c.content })));
    if (url.includes('/conclusions/list')) return ok({ items: held.filter((c) => c.level === body?.filters?.level) });
    return ok({});
  };
  return { fetch, calls };
};

const setup = (held: Conclusion[] = []) => {
  const home = temp();
  const memory = new MemoryStore(home);
  const memoryFile = path.join(home, 'honcho-memory.json');
  const honcho = fakeHoncho(held);
  const feed = new HonchoFeed({ store: new Store(initialState('test', 'ask')), sharedWith: () => false, file: null, queueFile: null, fetch: honcho.fetch, now: () => NOW, memory, memoryFile });
  feed.configure({ enabled: true, url: URL });
  return { memory, memoryFile, honcho, feed };
};

const writes = (calls: readonly Call[]) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/conclusions'));
const deletes = (calls: readonly Call[]) => calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop());

describe('memory about you, written to Honcho (BLG-124)', () => {
  it('writes each entry as what the user said about themselves, once, and keeps which is whose 0600', async () => {
    const { memory, memoryFile, honcho, feed } = setup();
    memory.add({ kind: 'user' }, 'Remoter is a hobby project, not work.', 'you');
    memory.write({ kind: 'user' }, { op: 'add', text: 'Helium is the browser on arch.', filed: true }, 'agent');
    memory.add({ kind: 'project', root: '/work/app' }, 'Tests run with vitest.', 'you');
    await feed.syncMemory();
    expect(writes(honcho.calls)).toHaveLength(1);
    expect(writes(honcho.calls)[0]?.body?.conclusions).toEqual([
      { content: `${CONFIRMED}Remoter is a hobby project, not work.`, observer_id: 'user', observed_id: 'user' },
      { content: `${CONFIRMED}Helium is the browser on arch.`, observer_id: 'user', observed_id: 'user' },
    ]);
    expect(statSync(memoryFile).mode & 0o777).toBe(0o600);
    expect(Object.values(loadSyncedMemory(memoryFile, { url: URL, workspace: 'beluga' }).entries).map((e) => e.conclusion)).toEqual(['c1', 'c2']);

    const before = honcho.calls.length;
    await feed.syncMemory();
    expect(honcho.calls).toHaveLength(before);
  });

  it('replaces a changed entry’s conclusion and forgets a removed one’s', async () => {
    const { memory, honcho, feed } = setup();
    const [a, b] = ['Likes tabs.', 'Uses zsh.'].map((t) => memory.add({ kind: 'user' }, t, 'you').entries.at(-1)!.id);
    await feed.syncMemory();
    memory.replace({ kind: 'user' }, a!, 'Likes spaces.', 'you');
    memory.remove({ kind: 'user' }, b!);
    await feed.syncMemory();
    expect(writes(honcho.calls)[1]?.body?.conclusions?.map((c) => c.content)).toEqual([`${CONFIRMED}Likes spaces.`]);
    expect(deletes(honcho.calls).sort()).toEqual(['c1', 'c2']);
  });

  it('starts over for another server, and stays quiet when Honcho is off', async () => {
    const { memory, memoryFile, feed } = setup();
    memory.add({ kind: 'user' }, 'Likes tabs.', 'you');
    await feed.syncMemory();
    expect(loadSyncedMemory(memoryFile, { url: 'http://elsewhere:8000', workspace: 'beluga' }).entries).toEqual({});
    const off = fakeHoncho();
    const quiet = new HonchoFeed({ store: new Store(initialState('test', 'ask')), sharedWith: () => false, file: null, queueFile: null, fetch: off.fetch, memory, memoryFile });
    await quiet.syncMemory();
    expect(off.calls).toHaveLength(0);
  });
});

describe('what Honcho noticed, offered to Tidy (BLG-124)', () => {
  const HELD: Conclusion[] = [
    { id: 'i1', content: 'user alternates between work Remoter and personal WoW projects', level: 'inductive', times_derived: 1 },
    { id: 'd1', content: 'user dual-boxes two WoW characters', level: 'deductive', times_derived: 1 },
    { id: 'e1', content: 'user prefers merge over rebase', level: 'explicit', times_derived: 3 },
    { id: 'e2', content: 'user was in a meeting', level: 'explicit', times_derived: 1 },
    { id: 'e3', content: `${CONFIRMED}Likes tabs.`, level: 'explicit', times_derived: 2 },
  ];

  it('offers what held up: dreamt, or derived more than once, never what Beluga wrote', async () => {
    const { feed } = setup(HELD);
    expect((await feed.noticed()).map((n) => n.id)).toEqual(['i1', 'd1', 'e1']);
  });

  const tidyWith = (notes: HonchoNote[], answer: object) => {
    const store = new Store(initialState('test', 'ask'));
    store.dispatch({ type: 'identity', selfId: 'me', isHost: true });
    const memory = new MemoryStore(temp());
    memory.add({ kind: 'user' }, 'Remoter is a hobby project, not work.', 'you');
    const forgot: string[] = [];
    const prompts: string[] = [];
    const reflection = new Reflection({
      store,
      ask: async (req) => (prompts.push(req.prompt), JSON.stringify(answer)),
      sharedWith: () => false,
      memory,
      file: null,
      now: () => NOW,
      honcho: () => ({ noticed: async () => notes, forgetNote: async (id) => void forgot.push(id) }),
    });
    return { store, memory, reflection, forgot, prompts };
  };

  it('Tidy may propose a note as a fact; Wrong makes Honcho forget it', async () => {
    const notes = [
      { id: 'e1', text: 'user prefers merge over rebase' },
      { id: 'i1', text: 'user alternates between work Remoter and personal WoW projects' },
    ];
    const { store, reflection, forgot, prompts } = tidyWith(notes, {
      proposals: [
        { scope: 'user', text: 'Merges, never rebases.', honcho: 'e1' },
        { scope: 'user', text: 'Works on Remoter professionally.', honcho: 'i1' },
        { scope: 'user', text: 'Made up.', honcho: 'nope' },
        { scope: 'user', text: 'Also made up.' },
      ],
    });
    expect(await reflection.tidy()).toEqual({ proposed: 2 });
    expect(prompts[0]).toContain('What Honcho noticed about the user (inferred, may be wrong):\n- [e1] user prefers merge over rebase');
    const [merge, remoter] = store.getState().memoryProposals;
    expect(merge).toMatchObject({ text: 'Merges, never rebases.', honcho: 'e1' });
    const card = waitingNeeds(store.getState()).find((i) => i.id === `memory-propose:${remoter!.id}`);
    expect(card).toMatchObject({ title: 'Remember what Honcho noticed about you?' });
    expect(card?.actions.map((x) => [x.label, x.tone, x.method])).toEqual([
      ['Keep', 'main', 'memory.keepProposal'],
      ['Discard', 'plain', 'memory.discardProposal'],
      ['Wrong', 'danger', 'memory.rejectProposal'],
    ]);
    await reflection.reject(remoter!.id);
    expect(forgot).toEqual(['i1']);
    expect(store.getState().memoryProposals.map((p) => p.id)).toEqual([merge!.id]);
    await expect(reflection.reject(merge!.id + 'x')).rejects.toThrow('already answered');
  });

  it('runs with an empty memory when Honcho has notes, and Wrong is refused on any other card', async () => {
    const { store, reflection } = tidyWith([], { proposals: [] });
    store.dispatch({ type: 'memory_proposal_add', proposal: { id: 'plain', kind: 'user', text: 'Likes tabs.', channel: '', askedAt: NOW } });
    await expect(reflection.reject('plain')).rejects.toThrow('Only something Honcho noticed');
    expect(PHONE['memory.rejectProposal']).toBe('phone');
  });
});
