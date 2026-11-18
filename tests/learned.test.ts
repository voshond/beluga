import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput, ChatTools } from '../src/agent/types.js';
import { learnedOf } from '../src/companion/views.js';
import { TurnView } from '../src/companion/protocol.js';
import { PHONE } from '../src/companion/coverage.js';
import { AgentHost } from '../src/core/agent-host.js';
import { withRecall } from '../src/core/learned.js';
import { memoryForRun } from '../src/core/memory/run.js';
import { MemoryError, MemoryStore } from '../src/core/memory/store.js';
import { type LogItem, Store, initialState } from '../src/core/store.js';
import { parseArgs } from '../src/ipc/api.js';
import { honchoSends } from '../src/ipc/honcho-handlers.js';
import { undoMemoryMark } from '../src/ipc/memory-handlers.js';
import type { HonchoStatus } from '../src/shared/honcho.js';
import { type LearnedDraft, type LearnedMark, learnedScope, learnedTitle } from '../src/shared/learned.js';
import { type MemoryChange, USER_MEMORY_MAX } from '../src/shared/memory.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { waitFor } from './helpers.js';

const SELF = 'me';
const USER = { kind: 'user' } as const;
const PROJECT = { kind: 'project', root: '/work/landing' } as const;
const tempHome = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-learned-'));

type AgentItem = Extract<LogItem, { type: 'agent' }>;

const storeWithCard = (channel = 'ws:a'): Store => {
  const store = new Store(initialState('test', 'ask'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true });
  store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'started', text: '', ts: 1, channel });
  return store;
};

const cardOf = (store: Store): AgentItem => store.getState().log.find((l): l is AgentItem => l.type === 'agent')!;

const learn = (store: Store, mark: LearnedMark): void => store.dispatch({ type: 'agent_learned', owner: SELF, requestId: 'r1', mark });

describe('a memory write says what it changed', () => {
  it('an add, a replace and a remove each hand back the entry before and after, and where it stood', () => {
    const store = new MemoryStore(tempHome());
    const add = store.write(USER, { op: 'add', text: 'Prefers short answers.' }, 'agent');
    expect(add.change).toMatchObject({ scope: USER, op: 'add', index: 0, after: { text: 'Prefers short answers.', by: 'agent' } });
    expect(add.change.before).toBeUndefined();
    store.add(USER, 'Uses zsh.', 'you');
    const replace = store.write(USER, { op: 'replace', entry: 'short', text: 'Prefers plain answers.' }, 'agent');
    expect(replace.change).toMatchObject({ op: 'replace', index: 0, before: { text: 'Prefers short answers.' }, after: { text: 'Prefers plain answers.' } });
    const remove = store.write(USER, { op: 'remove', entry: 'zsh' }, 'agent');
    expect(remove.change).toMatchObject({ op: 'remove', index: 1, before: { text: 'Uses zsh.' } });
    expect(remove.view.entries.map((e) => e.text)).toEqual(['Prefers plain answers.']);
  });

  it('a run reports each write it makes', () => {
    const changes: MemoryChange[] = [];
    const memory = memoryForRun(new MemoryStore(tempHome()), { root: PROJECT.root, name: 'landing' }, (c) => changes.push(c));
    memory.tools.add('project', 'Run npm ci before tests.');
    memory.tools.replace('project', 'npm ci', 'Run npm ci first.');
    memory.tools.remove('project', 'npm ci');
    expect(changes.map((c) => c.op)).toEqual(['add', 'replace', 'remove']);
    expect(changes[0]!.scope).toEqual({ kind: 'project', root: PROJECT.root });
    expect(() => memory.tools.add('project', 'x'.repeat(3000))).toThrow();
    expect(changes).toHaveLength(3);
  });
});

describe('undo', () => {
  it('removes an add', () => {
    const store = new MemoryStore(tempHome());
    const { change } = store.write(USER, { op: 'add', text: 'Likes tests first.' }, 'agent');
    expect(store.undo(change).entries).toEqual([]);
  });

  it('restores a replace', () => {
    const store = new MemoryStore(tempHome());
    store.add(USER, 'Likes tests first.', 'you');
    const before = store.read(USER).entries[0]!;
    const { change } = store.write(USER, { op: 'replace', entry: before.id, text: 'Likes tests last.' }, 'agent');
    expect(store.undo(change).entries).toEqual([before]);
  });

  it('puts a remove back where it stood', () => {
    const store = new MemoryStore(tempHome());
    store.add(PROJECT, 'one', 'you');
    store.add(PROJECT, 'two', 'you');
    store.add(PROJECT, 'three', 'you');
    const { change } = store.write(PROJECT, { op: 'remove', entry: 'two' }, 'agent');
    expect(store.undo(change).entries.map((e) => e.text)).toEqual(['one', 'two', 'three']);
  });

  it('refuses a second undo, with nothing changed', () => {
    const store = new MemoryStore(tempHome());
    const added = store.write(USER, { op: 'add', text: 'a fact' }, 'agent').change;
    store.undo(added);
    expect(() => store.undo(added)).toThrow(/gone already/);
    store.add(USER, 'kept', 'you');
    const removed = store.write(USER, { op: 'remove', entry: 'kept' }, 'agent').change;
    store.undo(removed);
    expect(() => store.undo(removed)).toThrow(/back already/);
    expect(store.read(USER).entries.map((e) => e.text)).toEqual(['kept']);
  });

  it('refuses when the entry changed again since', () => {
    const store = new MemoryStore(tempHome());
    const added = store.write(USER, { op: 'add', text: 'first words' }, 'agent').change;
    store.replace(USER, added.after!.id, 'other words', 'you');
    expect(() => store.undo(added)).toThrow(/changed since/);
    const replaced = store.write(USER, { op: 'replace', entry: added.after!.id, text: 'third words' }, 'agent').change;
    store.remove(USER, added.after!.id);
    expect(() => store.undo(replaced)).toThrow(/removed since/);
    const removed = store.write(USER, { op: 'add', text: 'same text' }, 'agent');
    const gone = store.write(USER, { op: 'remove', entry: removed.change.after!.id }, 'agent').change;
    store.add(USER, 'Same text', 'you');
    expect(() => store.undo(gone)).toThrow(/remembered again/);
  });

  it('refuses to put an entry back over the cap, and says to make room', () => {
    const store = new MemoryStore(tempHome());
    store.add(USER, 'a'.repeat(400), 'you');
    const gone = store.write(USER, { op: 'remove', entry: 'aaaa' }, 'agent').change;
    store.add(USER, 'b'.repeat(USER_MEMORY_MAX - 100), 'you');
    expect(() => store.undo(gone)).toThrow(MemoryError);
    expect(() => store.undo(gone)).toThrow(/full.*Make room first/);
    expect(store.read(USER).entries).toHaveLength(1);
  });

  it('through the API: marks the card’s marker undone, and refuses it twice', () => {
    const memory = new MemoryStore(tempHome());
    const store = storeWithCard();
    const { change } = memory.write(USER, { op: 'add', text: 'Uses zsh.' }, 'agent');
    learn(store, { id: 'm1', kind: 'memory', ts: 2, change });
    expect(undoMemoryMark({ store }, 'ws:a', cardOf(store).id, 'm1', memory).entries).toEqual([]);
    expect(cardOf(store).learned?.[0]).toMatchObject({ id: 'm1', undone: expect.any(Number) });
    expect(() => undoMemoryMark({ store }, 'ws:a', cardOf(store).id, 'm1', memory)).toThrow(/undone already/);
    expect(() => undoMemoryMark({ store }, 'ws:b', cardOf(store).id, 'm1', memory)).toThrow(/isn’t in this conversation/);
  });

  it('is a Mac-only method that takes the conversation, the card and the marker', () => {
    expect(PHONE['memory.undo']).toBe('mac');
    expect(PHONE['honcho.sends']).toBe('mac');
    expect(() => parseArgs('memory.undo', ['ws:a', 'me:r1', 'm1'])).not.toThrow();
    expect(() => parseArgs('memory.undo', ['ws:a', 'me:r1'])).toThrow();
  });
});

describe('markers on the card', () => {
  it('are kept on the run’s card, the newest last, and survive the conversation being loaded again', () => {
    const store = storeWithCard();
    learn(store, { id: 'q1', kind: 'recall', ts: 2, query: 'nas deploy' });
    learn(store, { id: 's1', kind: 'skill', ts: 3, proposal: 'skill-1', name: 'deploy-nas', update: false });
    store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'done', text: 'Done.', ts: 4, channel: 'ws:a' });
    expect(cardOf(store).learned?.map((m) => m.id)).toEqual(['q1', 's1']);
    const saved = JSON.parse(JSON.stringify(store.getState().log.filter((l) => l.channel === 'ws:a'))) as LogItem[];
    const fresh = new Store(initialState('test', 'ask'));
    fresh.dispatch({ type: 'history', channel: 'ws:a', items: saved });
    expect(cardOf(fresh).learned).toEqual(cardOf(store).learned);
  });

  it('change nothing for a card that isn’t there', () => {
    const store = storeWithCard();
    const before = store.getState();
    store.dispatch({ type: 'agent_learned', owner: SELF, requestId: 'nope', mark: { id: 'q', kind: 'recall', ts: 1, query: 'x' } });
    expect(store.getState().log).toBe(before.log);
  });

  it('read in words', () => {
    const change: MemoryChange = { scope: PROJECT, op: 'replace', before: { id: 'e', text: 'a', at: 1, by: 'you' }, after: { id: 'e', text: 'b', at: 2, by: 'agent' }, index: 0 };
    expect(learnedTitle({ id: '1', kind: 'memory', ts: 1, change })).toBe('Changed a memory');
    expect(learnedScope({ id: '1', kind: 'memory', ts: 1, change, project: 'landing' })).toBe('landing');
    expect(learnedScope({ id: '1', kind: 'memory', ts: 1, change: { ...change, scope: USER } })).toBe('About you');
    expect(learnedTitle({ id: '2', kind: 'skill', ts: 1, proposal: 'p', name: 'deploy', update: true })).toBe('Proposed a change to the skill deploy');
    expect(learnedTitle({ id: '3', kind: 'recall', ts: 1, query: 'nas' })).toBe('Searched past chats for “nas”');
  });

  it('a search of past chats is marked with its words, after it answered', () => {
    const marks: LearnedDraft[] = [];
    const chats = { search: () => 'hits' } as unknown as ChatTools;
    expect(withRecall(chats, (d) => marks.push(d))!.search('  deploy   to nas ', {})).toBe('hits');
    expect(marks).toEqual([{ kind: 'recall', query: 'deploy to nas' }]);
    expect(withRecall(chats, undefined)).toBe(chats);
    const failing = { search: () => { throw new Error('no'); } } as unknown as ChatTools;
    expect(() => withRecall(failing, (d) => marks.push(d))!.search('x', {})).toThrow();
    expect(marks).toHaveLength(1);
  });
});

describe('your own run marks its card', () => {
  const host = (store: Store, run: (input: AgentRunInput) => void) => {
    const agent: AgentBackend = {
      async run(input) {
        run(input);
        return 'ok';
      },
    };
    const memory = new MemoryStore(tempHome());
    return new AgentHost({
      store,
      selfId: () => SELF,
      send: ((body: { kind: string; requestId: string; requester: string; event: 'started'; text: string; channel: string }) => {
        if (body.kind === 'agent_event') store.dispatch({ type: 'agent_event', owner: SELF, requestId: body.requestId, requester: body.requester, event: body.event, text: body.text, ts: Date.now(), channel: body.channel });
        return true;
      }) as never,
      agent: () => agent,
      shares: {} as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
      people: {} as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      toast: () => undefined,
      system: () => undefined,
      approvalTimeoutMs: () => 60_000,
      refreshUsage: async () => undefined,
      memory: (_channel, _cwd, mark) => memoryForRun(memory, undefined, (change) => mark?.({ kind: 'memory', change })),
      skills: (_agent, mark) => ({ read: () => '', propose: () => (mark?.({ kind: 'skill', proposal: 'skill-1', name: 'deploy-nas', update: false }), 'ok'), proposeChange: () => 'ok' }),
    });
  };

  it('with each memory write and skill it proposes', async () => {
    const store = new Store(initialState('room', 'auto'));
    store.dispatch({ type: 'identity', selfId: SELF, isHost: true });
    const h = host(store, (input) => {
      input.memoryTools?.add('user', 'Prefers short answers.');
      void input.skillTools?.propose({ name: 'deploy-nas', description: 'Deploy to the NAS.', body: 'Steps here.' });
    });
    await h.onAgentRequest(SELF, { kind: 'agent_request', requestId: 'r1', prompt: 'hi', viaAgent: false, channel: 'room', urgent: false, plan: false });
    await waitFor(() => (cardOf(store)?.learned?.length ?? 0) === 2);
    const [memory, skill] = cardOf(store).learned!;
    expect(memory).toMatchObject({ kind: 'memory', change: { op: 'add', after: { text: 'Prefers short answers.' } } });
    expect(skill).toMatchObject({ kind: 'skill', name: 'deploy-nas' });
  });

  it('never a friend’s run: it gets no memory, so nothing is marked', async () => {
    const store = new Store(initialState('room', 'auto'));
    store.dispatch({ type: 'identity', selfId: SELF, isHost: true });
    let tools: AgentRunInput['memoryTools'];
    const h = host(store, (input) => void (tools = input.memoryTools));
    await h.onAgentRequest('bob', { kind: 'agent_request', requestId: 'r2', prompt: 'hi', viaAgent: false, channel: 'room', urgent: false, plan: false });
    await waitFor(() => store.getState().log.some((l) => l.type === 'agent' && l.status === 'done'));
    expect(tools).toBeUndefined();
    expect(cardOf(store)?.learned).toBeUndefined();
  });
});

describe('the phone', () => {
  it('reads the markers, read-only, and says what waits in Needs You', () => {
    const store = storeWithCard();
    const change: MemoryChange = { scope: PROJECT, op: 'add', after: { id: 'e', text: 'Run npm ci first.', at: 1, by: 'agent' }, index: 0 };
    learn(store, { id: 'm1', kind: 'memory', ts: 2, change, project: 'landing' });
    learn(store, { id: 's1', kind: 'skill', ts: 3, proposal: 'skill-1', name: 'deploy-nas', update: false });
    learn(store, { id: 'q1', kind: 'recall', ts: 4, query: 'nas' });
    store.dispatch({ type: 'skill_proposal_add', proposal: { id: 'skill-1', name: 'deploy-nas', text: '---\n', from: 'Claude', askedAt: 1 } });
    store.dispatch({ type: 'agent_learned_undone', itemId: cardOf(store).id, markId: 'm1', at: 5 });
    const views = learnedOf(store.getState(), cardOf(store));
    expect(views).toEqual([
      { id: 'm1', kind: 'memory', title: 'Remembered', text: 'Run npm ci first.', scope: 'landing', undone: true },
      { id: 's1', kind: 'skill', title: 'Proposed the skill deploy-nas', waiting: true },
      { id: 'q1', kind: 'recall', title: 'Searched past chats for “nas”', text: 'nas' },
    ]);
    expect(TurnView.shape.learned.safeParse(views).success).toBe(true);
  });

  it('sees no markers on someone else’s agent’s card', () => {
    const store = storeWithCard();
    learn(store, { id: 'q1', kind: 'recall', ts: 4, query: 'nas' });
    expect(learnedOf({ ...store.getState(), selfId: 'someone-else' }, cardOf(store))).toEqual([]);
  });
});

describe('the Honcho sign', () => {
  const ws = (id: string, more: Partial<Workspace> = {}): Workspace => ({ id, projectId: 'p1', projectRoot: '/code/app', name: `task ${id}`, path: `/wt/${id}`, kind: 'worktree', branch: `beluga/${id}`, createdAt: 1, external: false, ...more });
  const project = (id: string, workspaces: Workspace[]): Project => ({ id, name: `project ${id}`, root: `/code/${id}`, base: 'origin/main', workspaces });
  const on: HonchoStatus = { enabled: true, url: 'http://localhost:8000', workspace: 'beluga', hasKey: false, excluded: [], sent: 0, queued: 0 };
  const session = (shared: readonly string[] = []) => {
    const store = new Store(initialState('test', 'ask'));
    store.dispatch({ type: 'identity', selfId: SELF, isHost: true });
    store.dispatch({ type: 'projects', projects: [project('p1', [ws('a'), ws('b'), ws('t', { thread: { parent: 'a' } as Workspace['thread'] })]), project('p2', [ws('c', { projectId: 'p2' })])] });
    return { store, sharing: { recipients: (c: string) => (shared.includes(c) ? ['bob'] : []) } } as unknown as Parameters<typeof honchoSends>[0];
  };

  it('shows where messages go to Honcho, and nowhere else', () => {
    expect(honchoSends(session(), 'ws:a', on)).toBe(true);
    expect(honchoSends(session(), 'mac:assistant', on)).toBe(true);
    expect(honchoSends(session(), 'ws:a', { ...on, enabled: false })).toBe(false);
    expect(honchoSends(session(), 'ws:a', undefined)).toBe(false);
    expect(honchoSends(session(), 'ws:c', { ...on, excluded: ['p2'] })).toBe(false);
    expect(honchoSends(session(['ws:b']), 'ws:b', on)).toBe(false);
    expect(honchoSends(session(), 'ws:t', on)).toBe(false);
    expect(honchoSends(session(), 'room', on)).toBe(false);
  });
});
