import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PHONE } from '../src/companion/coverage.js';
import { waitingNeeds } from '../src/companion/needs-you.js';
import { MAX_PENDING_MEMORY, REFLECTION_MIN_MESSAGES, Reflection, type ReflectionAsk, launchReflection, loadReflection, proposalsFrom, reflectionSource } from '../src/core/memory/reflection.js';
import { COMMANDS, runCommand } from '../src/core/commands.js';
import { Session } from '../src/core/session.js';
import { FILED_MEMORY_MAX, lookBackWords, tidyWords } from '../src/shared/memory.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { type Action, type MemoryProposal, Store, initialState } from '../src/core/store.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const SELF = 'me';
const NOW = new Date(2026, 10, 18, 12).getTime();
const ROOT = '/code/app';

const ws = (id: string, more: Partial<Workspace> = {}): Workspace => ({ id, projectId: 'p1', projectRoot: ROOT, name: `task ${id}`, path: `/wt/${id}`, kind: 'worktree', branch: `beluga/${id}`, createdAt: NOW, external: false, ...more });
const project = (workspaces: Workspace[]): Project => ({ id: 'p1', name: 'app', root: ROOT, base: 'origin/main', workspaces });

const storeWith = (): Store => {
  const store = new Store(initialState('test', 'ask'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true });
  store.dispatch({ type: 'projects', projects: [project([ws('a'), ws('b'), ws('shared'), ws('t', { thread: { parent: 'a' } as Workspace['thread'] })])] });
  return store;
};

let n = 0;
const said = (channel: string, text: string, byAgent = false): Action => ({ type: 'chat', id: `m-${n++}`, from: SELF, text, ts: NOW + n, byAgent, channel });

const talk = (store: Store, channel: string, turns: number): void => {
  for (let i = 0; i < turns; i++) {
    store.dispatch(said(channel, `Request ${i}: no, use pnpm here, not npm.`));
    store.dispatch(said(channel, `Done ${i}.`, true));
  }
};

const homeDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-reflection-'));

type Asked = { calls: Array<{ prompt: string; system: string; model: string }>; ask: ReflectionAsk };

const answering = (answer: string | (() => string)): Asked => {
  const calls: Asked['calls'] = [];
  return {
    calls,
    ask: async (req) => {
      calls.push(req);
      return typeof answer === 'string' ? answer : answer();
    },
  };
};

const answer = (proposals: ReadonlyArray<Record<string, string | readonly string[]>>): string => `Here you go:\n${JSON.stringify({ proposals })}`;

const setup = (reply: string, file: string | null = null) => {
  const home = homeDir();
  const store = storeWith();
  const memory = new MemoryStore(home);
  const asked = answering(reply);
  const reflection = new Reflection({ store, ask: asked.ask, sharedWith: (c) => c === 'ws:shared', memory, file, now: () => NOW });
  return { store, memory, asked, reflection, home };
};

describe('which conversations it reads', () => {
  it('reads your own conversation as messages, and refuses a shared one, a thread and the room', () => {
    const store = storeWith();
    talk(store, 'ws:a', 3);
    const source = reflectionSource(store.getState(), 'ws:a', () => false);
    expect(source).toMatchObject({ channel: 'ws:a', root: ROOT, project: 'app', messages: 6, yours: 3 });
    expect(source?.lines[0]).toContain('User');
    expect(reflectionSource(store.getState(), 'ws:shared', (c) => c === 'ws:shared')).toBeUndefined();
    expect(reflectionSource(store.getState(), 'ws:t', () => false)).toBeUndefined();
    expect(reflectionSource(store.getState(), 'room', () => false)).toBeUndefined();
    expect(reflectionSource(store.getState(), 'ws:nowhere', () => false)).toBeUndefined();
  });

  it('redacts secrets before the model sees them', async () => {
    const { store, asked, reflection } = setup(answer([]));
    talk(store, 'ws:a', 3);
    store.dispatch(said('ws:a', 'the key is ghp_0123456789abcdefghijABCDEFGHIJ012345'));
    await reflection.reflect('ws:a', 'manual');
    expect(asked.calls[0]?.prompt).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ012345');
  });
});

describe('a pass', () => {
  it('proposes what the model found, on a cheap model, with the memory it sees', async () => {
    const { store, asked, reflection, memory } = setup(answer([{ scope: 'user', text: 'Prefers pnpm over npm.', why: 'Corrected npm twice.' }, { scope: 'project', text: 'Tests run with vitest.' }]));
    memory.add({ kind: 'user' }, 'Writes in English.', 'you');
    talk(store, 'ws:a', 3);
    expect(await reflection.reflect('ws:a', 'manual')).toEqual({ proposed: 2 });
    expect(asked.calls[0]?.model).toBe('haiku');
    expect(asked.calls[0]?.prompt).toContain('Writes in English.');
    const [user, proj] = store.getState().memoryProposals;
    expect(user).toMatchObject({ kind: 'user', text: 'Prefers pnpm over npm.', reason: 'Corrected npm twice.', channel: 'ws:a', askedAt: NOW });
    expect(proj).toMatchObject({ kind: 'project', root: ROOT, project: 'app', text: 'Tests run with vitest.' });
  });

  it('uses the model picked in Settings', async () => {
    const { store, asked, reflection } = setup(answer([]));
    store.dispatch({ type: 'prefs', prefs: { reflectionModel: 'gpt-5-mini' } });
    talk(store, 'ws:a', 3);
    await reflection.reflect('ws:a', 'manual');
    expect(asked.calls[0]?.model).toBe('gpt-5-mini');
  });

  it('skips a short conversation without calling the model', async () => {
    const { store, asked, reflection } = setup(answer([{ scope: 'user', text: 'x' }]));
    talk(store, 'ws:a', REFLECTION_MIN_MESSAGES / 2 - 1);
    expect(await reflection.reflect('ws:a', 'manual')).toMatchObject({ skipped: 'short' });
    expect(asked.calls).toHaveLength(0);
    expect(store.getState().memoryProposals).toHaveLength(0);
  });

  it('makes no card when there is nothing new', async () => {
    const { store, reflection } = setup('{"proposals":[]}');
    talk(store, 'ws:a', 3);
    expect(await reflection.reflect('ws:a', 'manual')).toEqual({ proposed: 0 });
    expect(waitingNeeds(store.getState()).filter((i) => i.id.startsWith('memory-propose:'))).toHaveLength(0);
  });

  it('the setting switches only the merge look back: Look Back by hand works with it off', async () => {
    const { store, asked, reflection } = setup(answer([]));
    store.dispatch({ type: 'prefs', prefs: { reflection: false } });
    talk(store, 'ws:a', 3);
    expect(await reflection.reflect('ws:a', 'merge')).toMatchObject({ skipped: 'off' });
    expect(asked.calls).toHaveLength(0);
    expect(await reflection.reflect('ws:a', 'manual')).toEqual({ proposed: 0 });
    expect(asked.calls).toHaveLength(1);
  });

  it('tries again after trouble, reading what the failed look back would have', async () => {
    const { store } = setup(answer([]));
    let fail = true;
    const calls: string[] = [];
    const flaky = new Reflection({ store, ask: async (req) => (calls.push(req.prompt), fail ? Promise.reject(new Error('it took too long')) : answer([])), sharedWith: () => false, memory: new MemoryStore(homeDir()), file: null });
    talk(store, 'ws:b', 3);
    expect(await flaky.reflect('ws:b', 'manual')).toMatchObject({ skipped: 'trouble' });
    fail = false;
    expect(await flaky.reflect('ws:b', 'manual')).toEqual({ proposed: 0 });
    expect(calls[1]).not.toContain('since the last look back');
    expect(calls[1]).toContain('Request 0');
  });

  it('refuses a shared conversation', async () => {
    const { store, reflection, asked } = setup(answer([]));
    talk(store, 'ws:shared', 3);
    expect(await reflection.reflect('ws:shared', 'manual')).toMatchObject({ skipped: 'not_yours' });
    expect(asked.calls).toHaveLength(0);
  });
});

describe('Look Back as you go (BLG-108)', () => {
  it('runs again on the same conversation, reading only what is new, with what came before as context', async () => {
    const { store, asked, reflection } = setup(answer([]));
    talk(store, 'ws:a', 3);
    expect(await reflection.reflect('ws:a', 'manual')).toEqual({ proposed: 0 });
    store.dispatch(said('ws:a', 'Later: always run the linter before committing.'));
    store.dispatch(said('ws:a', 'Noted.', true));
    expect(await reflection.reflect('ws:a', 'manual')).toEqual({ proposed: 0 });
    expect(asked.calls).toHaveLength(2);
    const [context, fresh] = asked.calls[1]!.prompt.split('The conversation since the last look back');
    expect(context).toContain('Said before the last look back (context only');
    expect(context).toContain('Request 2');
    expect(fresh).toContain('always run the linter');
    expect(fresh).not.toContain('Request 2');
  });

  it('says there is nothing new without calling a model', async () => {
    const { store, asked, reflection } = setup(answer([]));
    talk(store, 'ws:a', 3);
    await reflection.reflect('ws:a', 'manual');
    expect(await reflection.reflect('ws:a', 'manual')).toMatchObject({ skipped: 'nothing_new', why: expect.stringContaining('Nothing new') });
    expect(asked.calls).toHaveLength(1);
  });

  it('keeps only a little of what came before as context', async () => {
    const { store, asked, reflection } = setup(answer([]));
    talk(store, 'ws:a', 3);
    store.dispatch(said('ws:a', `old ${'x'.repeat(5_000)}`));
    await reflection.reflect('ws:a', 'manual');
    store.dispatch(said('ws:a', 'new words'));
    await reflection.reflect('ws:a', 'manual');
    expect(asked.calls[1]!.prompt).not.toContain('old x');
    expect(asked.calls[1]!.prompt).toContain('new words');
  });

  it('the merge look back after a manual one reads only what came after it, and runs once', async () => {
    const { store, asked, reflection } = setup(answer([]));
    talk(store, 'ws:a', 3);
    await reflection.reflect('ws:a', 'manual');
    expect(await reflection.reflect('ws:a', 'merge')).toMatchObject({ skipped: 'nothing_new' });
    expect(asked.calls).toHaveLength(1);
    store.dispatch(said('ws:a', 'One more thing: tests live in tests/.'));
    expect(await reflection.reflect('ws:a', 'merge')).toMatchObject({ skipped: 'done' });
    expect(asked.calls).toHaveLength(1);
    expect(await reflection.reflect('ws:a', 'manual')).toEqual({ proposed: 0 });
    expect(asked.calls[1]!.prompt.split('since the last look back').at(-1)).toContain('tests live in tests/');
  });

  it('a merge after a manual look back with something new reads only the new part', async () => {
    const { store, asked, reflection } = setup(answer([]));
    talk(store, 'ws:a', 3);
    await reflection.reflect('ws:a', 'manual');
    store.dispatch(said('ws:a', 'Use the staging database for this.'));
    expect(await reflection.reflect('ws:a', 'merge')).toEqual({ proposed: 0 });
    const fresh = asked.calls[1]!.prompt.split('The conversation since the last look back').at(-1)!;
    expect(fresh).toContain('staging database');
    expect(fresh).not.toContain('Request 0');
  });

  it('two quick asks never run two passes on one conversation at once', async () => {
    const { store, asked, reflection } = setup(answer([]));
    talk(store, 'ws:a', 3);
    const [one, two] = await Promise.all([reflection.reflect('ws:a', 'manual'), reflection.reflect('ws:a', 'manual')]);
    expect(one).toEqual({ proposed: 0 });
    expect(two).toMatchObject({ skipped: 'running' });
    expect(asked.calls).toHaveLength(1);
  });

  it('says what came of it in words', () => {
    expect(lookBackWords({ proposed: 2 })).toBe('2 things to remember: see Needs You.');
    expect(lookBackWords({ proposed: 2, skill: 'new' })).toBe('1 thing to remember and a skill to keep: see Needs You.');
    expect(lookBackWords({ proposed: 1, skill: 'change' })).toBe('A fix to a skill: see Needs You.');
    expect(lookBackWords({ proposed: 0 })).toBe('Looked back: nothing worth keeping this time.');
    expect(lookBackWords({ skipped: 'short', why: 'Too short.' })).toBe('Too short.');
  });

  it('/lookback is a command that looks back at the conversation you are in, and says what came of it', async () => {
    expect(COMMANDS.find((c) => c.name === 'lookback')?.desc).toBeTruthy();
    const { store, asked } = setup(answer([{ scope: 'user', text: 'Prefers pnpm over npm.' }]));
    talk(store, 'ws:a', 3);
    const toasts: Array<[string, string]> = [];
    const session = { store, toast: (text: string, level: string) => void toasts.push([text, level]), lookBack: (channel: string) => Session.prototype.lookBack.call(session as never, channel) };
    const stop = launchReflection({ session, store, ask: asked.ask, sharedWith: () => false, file: null });
    runCommand(session as never, 'lookback', [], 'ws:a', '/lookback');
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toEqual(['1 thing to remember: see Needs You.', 'success']);
    runCommand(session as never, 'lookback', [], 'ws:a', '/lookback');
    await vi.waitFor(() => expect(toasts).toHaveLength(2));
    expect(toasts[1]).toEqual(['Nothing new was said here since the last look back.', 'info']);
    stop();
  });

  it('/lookback without the daemon says where it runs', async () => {
    const toasts: string[] = [];
    const session = { toast: (text: string) => void toasts.push(text) };
    expect(await Session.prototype.lookBack.call(session as never, 'ws:a')).toBeUndefined();
    expect(toasts[0]).toContain('Beluga’s app');
  });
});

describe('the merge trigger', () => {
  it('looks back when a worktree merges, once', async () => {
    const { store, reflection, asked } = setup(answer([{ scope: 'user', text: 'Prefers pnpm over npm.' }]));
    talk(store, 'ws:a', 3);
    const stop = reflection.start();
    store.dispatch({ type: 'system', text: 'merged', channel: 'ws:a', id: 'merge-1', merged: { into: 'main' } });
    await new Promise((r) => setTimeout(r, 0));
    store.dispatch({ type: 'system', text: 'merged again', channel: 'ws:a', id: 'merge-2', merged: { into: 'main' } });
    await new Promise((r) => setTimeout(r, 0));
    stop();
    expect(asked.calls).toHaveLength(1);
    expect(store.getState().memoryProposals).toHaveLength(1);
  });

  it('does not look back at merges from before it started', () => {
    const { store, reflection, asked } = setup(answer([]));
    talk(store, 'ws:a', 3);
    store.dispatch({ type: 'system', text: 'merged', channel: 'ws:a', id: 'old', merged: { into: 'main' } });
    const stop = reflection.start();
    store.dispatch(said('ws:a', 'hello'));
    stop();
    expect(asked.calls).toHaveLength(0);
  });
});

const ctx = (more: Partial<Parameters<typeof proposalsFrom>[1]> = {}): Parameters<typeof proposalsFrom>[1] => ({
  source: { channel: 'ws:a', root: ROOT, project: 'app', lines: [], earlier: [], messages: 6, yours: 3, latest: 0 },
  user: { scope: { kind: 'user' }, label: 'About you', entries: [{ id: 'u1', text: 'Writes in English.', at: 0, by: 'you' }], used: 18, cap: 1375, filedUsed: 0, filedCap: FILED_MEMORY_MAX },
  project: { scope: { kind: 'project', root: ROOT }, label: 'app', entries: [], used: 0, cap: 2200, filedUsed: 0, filedCap: FILED_MEMORY_MAX },
  discarded: [],
  pending: [],
  now: NOW,
  ...more,
});

describe('reading the answer', () => {
  it('never proposes a secret, a duplicate, a discarded one, or one over the limit', () => {
    const raw = answer([
      { scope: 'user', text: 'Their token: ghp_0123456789abcdefghijABCDEFGHIJ012345' },
      { scope: 'user', text: 'password = hunter22' },
      { scope: 'user', text: 'writes in english' },
      { scope: 'user', text: 'Likes tabs.' },
      { scope: 'user', text: 'x'.repeat(301) },
      { scope: 'project', text: 'Deploys go through Watchtower.' },
    ]);
    const out = proposalsFrom(raw, ctx({ discarded: ['Likes tabs'] }));
    expect(out.map((p) => p.text)).toEqual(['Deploys go through Watchtower.']);
  });

  it('turns a replace into an Update with the entry as it is now', () => {
    const [p] = proposalsFrom(answer([{ scope: 'user', text: 'Writes in English, answers in German.', replaces: 'u1' }]), ctx());
    expect(p).toMatchObject({ entry: 'u1', previous: 'Writes in English.' });
  });

  it('keeps project proposals out of a conversation with no project, and garbage gives nothing', () => {
    expect(proposalsFrom(answer([{ scope: 'project', text: 'A fact.' }]), ctx({ project: undefined }))).toEqual([]);
    expect(proposalsFrom('not json at all', ctx())).toEqual([]);
  });

  it('proposes at most 3, and none past the waiting limit', () => {
    const many = answer(['a', 'b', 'c', 'd'].map((t) => ({ scope: 'user', text: `Fact ${t}.` })));
    expect(proposalsFrom(many, ctx())).toHaveLength(3);
    const waiting = Array.from({ length: MAX_PENDING_MEMORY }, (_, i): MemoryProposal => ({ id: `w${i}`, kind: 'user', text: `Waiting ${i}.`, channel: 'ws:a', askedAt: NOW }));
    expect(proposalsFrom(many, ctx({ pending: waiting }))).toEqual([]);
  });
});

describe('Keep, Update and Discard', () => {
  it('Keep writes the entry and drops the card', async () => {
    const { store, memory, reflection } = setup(answer([{ scope: 'project', text: 'Tests run with vitest.' }]));
    talk(store, 'ws:a', 3);
    await reflection.reflect('ws:a', 'manual');
    const [p] = store.getState().memoryProposals;
    const card = waitingNeeds(store.getState()).find((i) => i.id === `memory-propose:${p!.id}`);
    expect(card).toMatchObject({ kind: 'decision', title: 'Remember this for app?' });
    expect(card?.actions).toEqual([
      { label: 'Keep', tone: 'main', method: 'memory.keepProposal', args: [p!.id] },
      { label: 'Discard', tone: 'danger', method: 'memory.discardProposal', args: [p!.id] },
    ]);
    reflection.keep(p!.id);
    expect(memory.read({ kind: 'project', root: ROOT }).entries.map((e) => e.text)).toEqual(['Tests run with vitest.']);
    expect(store.getState().memoryProposals).toHaveLength(0);
    expect(() => reflection.keep(p!.id)).toThrow('already answered');
  });

  it('Update changes the entry, and is refused when the entry changed since', () => {
    const { store, memory, reflection } = setup('');
    const id = memory.add({ kind: 'user' }, 'Writes in English.', 'you').entries[0]!.id;
    const update = (pid: string): MemoryProposal => ({ id: pid, kind: 'user', text: 'Writes in English, answers in German.', entry: id, previous: 'Writes in English.', channel: 'ws:a', askedAt: NOW });
    store.dispatch({ type: 'memory_proposal_add', proposal: update('p1') });
    expect(waitingNeeds(store.getState()).find((i) => i.id === 'memory-propose:p1')?.actions[0]?.label).toBe('Update');
    reflection.keep('p1');
    expect(memory.read({ kind: 'user' }).entries.map((e) => e.text)).toEqual(['Writes in English, answers in German.']);

    store.dispatch({ type: 'memory_proposal_add', proposal: update('p2') });
    expect(() => reflection.keep('p2')).toThrow('changed since');
    expect(store.getState().memoryProposals).toHaveLength(1);
  });

  it('Discard writes nothing and the same thing is not proposed again', async () => {
    const { store, memory, reflection, asked } = setup(answer([{ scope: 'user', text: 'Prefers pnpm over npm.' }]));
    talk(store, 'ws:a', 3);
    await reflection.reflect('ws:a', 'manual');
    reflection.discard(store.getState().memoryProposals[0]!.id);
    expect(memory.read({ kind: 'user' }).entries).toHaveLength(0);
    store.dispatch(said('ws:a', 'Still pnpm, please.'));
    expect(await reflection.reflect('ws:a', 'merge')).toEqual({ proposed: 0 });
    expect(asked.calls[1]?.prompt).toContain('- Prefers pnpm over npm.');
  });

  it('the phone answers the cards', () => {
    expect(PHONE['memory.keepProposal']).toBe('phone');
    expect(PHONE['memory.discardProposal']).toBe('phone');
    expect(PHONE['memory.reflect']).toBe('mac');
  });
});

describe('tidying a memory (BLG-120, BLG-121)', () => {
  const entry = (id: string, text: string) => ({ id, text, at: 0, by: 'you' as const });
  const crowded = (): Parameters<typeof proposalsFrom>[1] =>
    ctx({
      user: { scope: { kind: 'user' }, label: 'About you', entries: [entry('u1', 'Uses Helium on arch.'), entry('u2', 'Uses Chromium on m1arch.'), entry('u3', 'Was in a meeting at 13:17.'), entry('u4', 'Tests in this app run with vitest.')], used: 100, cap: 1375, filedUsed: 0, filedCap: FILED_MEMORY_MAX },
      project: { scope: { kind: 'project', root: ROOT }, label: 'app', entries: [entry('p1', 'Prefers German UI copy.')], used: 23, cap: 2200, filedUsed: 0, filedCap: FILED_MEMORY_MAX },
    });

  it('reads a merge, a forget and a move both ways', () => {
    const out = proposalsFrom(
      answer([
        { scope: 'user', text: 'Uses Helium on arch, Chromium on m1arch.', replaces: 'u1', merges: ['u2', 'nope'] },
        { forget: 'u3', why: 'One-off.' },
        { move: 'u4', scope: 'project' },
        { move: 'p1', scope: 'user', text: 'Prefers German UI copy everywhere.' },
      ]),
      crowded(),
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ kind: 'user', entry: 'u1', previous: 'Uses Helium on arch.', merges: [{ id: 'u2', text: 'Uses Chromium on m1arch.' }] });
    expect(out[1]).toMatchObject({ kind: 'user', entry: 'u3', text: 'Was in a meeting at 13:17.', drop: true, reason: 'One-off.' });
    expect(out[2]).toMatchObject({ kind: 'project', root: ROOT, project: 'app', entry: 'u4', text: 'Tests in this app run with vitest.', from: { kind: 'user' } });
    const back = proposalsFrom(answer([{ move: 'p1', scope: 'user', text: 'Prefers German UI copy everywhere.' }]), crowded());
    expect(back[0]).toMatchObject({ kind: 'user', entry: 'p1', previous: 'Prefers German UI copy.', text: 'Prefers German UI copy everywhere.', from: { kind: 'project', root: ROOT, project: 'app' } });
  });

  it('drops a move to where it already is, to nowhere, or onto a twin, and never changes one entry twice', () => {
    expect(proposalsFrom(answer([{ move: 'u1', scope: 'user' }, { move: 'u1', scope: 'mars' }, { forget: 'ghost' }]), crowded())).toEqual([]);
    const twice = proposalsFrom(answer([{ forget: 'u1' }, { scope: 'user', text: 'Uses Helium.', replaces: 'u1' }]), crowded());
    expect(twice.map((p) => p.drop)).toEqual([true]);
    const waiting: MemoryProposal = { id: 'w', kind: 'user', text: 'x', entry: 'u3', previous: 'Was in a meeting at 13:17.', drop: true, channel: '', askedAt: NOW };
    expect(proposalsFrom(answer([{ forget: 'u3' }]), { ...crowded(), pending: [waiting] })).toEqual([]);
  });

  it('a tidy pass never proposes a new fact', () => {
    const out = proposalsFrom(answer([{ scope: 'user', text: 'Brand new fact.' }, { forget: 'u3' }]), { ...crowded(), tidy: true });
    expect(out.map((p) => p.drop)).toEqual([true]);
  });

  it('a discarded forget is remembered as one, and not proposed again', async () => {
    const { store, memory, asked, reflection } = setup(answer([]));
    const id = memory.add({ kind: 'user' }, 'Was in a meeting at 13:17.', 'you').entries[0]!.id;
    store.dispatch({ type: 'memory_proposal_add', proposal: { id: 'f', kind: 'user', text: 'Was in a meeting at 13:17.', entry: id, previous: 'Was in a meeting at 13:17.', drop: true, channel: '', askedAt: NOW } });
    reflection.discard('f');
    await reflection.tidy();
    expect(asked.calls[0]?.prompt).toContain('- Forget: Was in a meeting at 13:17.');
    expect(proposalsFrom(answer([{ forget: id }]), ctx({ user: memory.read({ kind: 'user' }), discarded: ['Forget: Was in a meeting at 13:17.'] }))).toEqual([]);
  });

  it('Merge folds the entries in one write, even when the memory is full', () => {
    const { store, memory, reflection } = setup('');
    const a = memory.add({ kind: 'user' }, 'A'.repeat(600), 'you').entries[0]!;
    const b = memory.add({ kind: 'user' }, 'B'.repeat(600), 'you').entries[1]!;
    const c = memory.add({ kind: 'user' }, 'C'.repeat(150), 'you').entries[2]!;
    expect(memory.read({ kind: 'user' }).used).toBe(1350);
    store.dispatch({ type: 'memory_proposal_add', proposal: { id: 'm', kind: 'user', text: 'AB'.repeat(350), entry: a.id, previous: a.text, merges: [{ id: b.id, text: b.text }], channel: '', askedAt: NOW } });
    const card = waitingNeeds(store.getState()).find((i) => i.id === 'memory-propose:m');
    expect(card).toMatchObject({ title: 'Merge 2 memories about you into one?' });
    expect(card?.actions.map((x) => x.label)).toEqual(['Merge', 'Discard']);
    reflection.keep('m');
    expect(memory.read({ kind: 'user' }).entries.map((e) => e.id)).toEqual([a.id, c.id]);
    expect(memory.read({ kind: 'user' }).entries[0]!.text).toBe('AB'.repeat(350));
  });

  it('Merge is refused, with nothing written, when a folded entry changed since', () => {
    const { store, memory, reflection } = setup('');
    const a = memory.add({ kind: 'user' }, 'Likes tabs.', 'you').entries[0]!;
    const b = memory.add({ kind: 'user' }, 'Likes spaces.', 'you').entries[1]!;
    store.dispatch({ type: 'memory_proposal_add', proposal: { id: 'm', kind: 'user', text: 'Likes both.', entry: a.id, previous: a.text, merges: [{ id: b.id, text: b.text }], channel: '', askedAt: NOW } });
    memory.replace({ kind: 'user' }, b.id, 'Hates spaces.', 'you');
    expect(() => reflection.keep('m')).toThrow('changed since');
    expect(memory.read({ kind: 'user' }).entries.map((e) => e.text)).toEqual(['Likes tabs.', 'Hates spaces.']);
  });

  it('Forget removes the entry; its card says Forget or Keep It', () => {
    const { store, memory, reflection } = setup('');
    const id = memory.add({ kind: 'user' }, 'Was in a meeting at 13:17.', 'you').entries[0]!.id;
    store.dispatch({ type: 'memory_proposal_add', proposal: { id: 'f', kind: 'user', text: 'Was in a meeting at 13:17.', entry: id, previous: 'Was in a meeting at 13:17.', drop: true, channel: '', askedAt: NOW } });
    const card = waitingNeeds(store.getState()).find((i) => i.id === 'memory-propose:f');
    expect(card).toMatchObject({ title: 'Forget this about you?' });
    expect(card?.actions.map((x) => [x.label, x.tone])).toEqual([
      ['Forget', 'main'],
      ['Keep It', 'plain'],
    ]);
    reflection.keep('f');
    expect(memory.read({ kind: 'user' }).entries).toEqual([]);
  });

  it('Move takes an entry from about you to a project and back', () => {
    const { store, memory, reflection } = setup('');
    const id = memory.add({ kind: 'user' }, 'Tests run with vitest.', 'you').entries[0]!.id;
    store.dispatch({ type: 'memory_proposal_add', proposal: { id: 'mv', kind: 'project', root: ROOT, project: 'app', text: 'Tests run with vitest.', entry: id, previous: 'Tests run with vitest.', from: { kind: 'user' }, channel: '', askedAt: NOW } });
    expect(waitingNeeds(store.getState()).find((i) => i.id === 'memory-propose:mv')).toMatchObject({ title: 'Remember this only for app?' });
    reflection.keep('mv');
    expect(memory.read({ kind: 'user' }).entries).toEqual([]);
    const moved = memory.read({ kind: 'project', root: ROOT }).entries;
    expect(moved.map((e) => e.text)).toEqual(['Tests run with vitest.']);

    store.dispatch({ type: 'memory_proposal_add', proposal: { id: 'up', kind: 'user', text: 'Tests always run with vitest.', entry: moved[0]!.id, previous: 'Tests run with vitest.', from: { kind: 'project', root: ROOT, project: 'app' }, channel: '', askedAt: NOW } });
    const card = waitingNeeds(store.getState()).find((i) => i.id === 'memory-propose:up');
    expect(card).toMatchObject({ title: 'Remember this everywhere, not only for app?', detail: expect.stringContaining('New: Tests always run with vitest.') });
    reflection.keep('up');
    expect(memory.read({ kind: 'project', root: ROOT }).entries).toEqual([]);
    expect(memory.read({ kind: 'user' }).entries.map((e) => e.text)).toEqual(['Tests always run with vitest.']);
  });

  it('Move into a full memory is refused, and the entry stays where it was', () => {
    const { store, memory, reflection } = setup('');
    memory.add({ kind: 'user' }, 'U'.repeat(1370), 'you');
    const id = memory.add({ kind: 'project', root: ROOT }, 'Prefers German UI copy.', 'you').entries[0]!.id;
    store.dispatch({ type: 'memory_proposal_add', proposal: { id: 'up', kind: 'user', text: 'Prefers German UI copy.', entry: id, previous: 'Prefers German UI copy.', from: { kind: 'project', root: ROOT }, channel: '', askedAt: NOW } });
    expect(() => reflection.keep('up')).toThrow('full');
    expect(memory.read({ kind: 'project', root: ROOT }).entries.map((e) => e.id)).toEqual([id]);
    expect(memory.read({ kind: 'user' }).entries).toHaveLength(1);
  });

  it('File Away takes an entry out of every run, and is offered only for one not filed yet (BLG-123)', () => {
    const { store, memory, reflection } = setup('');
    const id = memory.add({ kind: 'user' }, 'Helium is the browser on arch.', 'you').entries[0]!.id;
    const out = proposalsFrom(answer([{ file: id, why: 'Only matters for browser work.' }]), ctx({ user: memory.read({ kind: 'user' }) }));
    expect(out[0]).toMatchObject({ kind: 'user', entry: id, file: true, text: 'Helium is the browser on arch.' });
    store.dispatch({ type: 'memory_proposal_add', proposal: out[0]! });
    const card = waitingNeeds(store.getState()).find((i) => i.id === `memory-propose:${out[0]!.id}`);
    expect(card).toMatchObject({ title: 'File this away about you, for the work it’s about?' });
    expect(card?.actions[0]?.label).toBe('File Away');
    reflection.keep(out[0]!.id);
    expect(memory.read({ kind: 'user' })).toMatchObject({ used: 0, filedUsed: 30 });
    expect(proposalsFrom(answer([{ file: id }]), ctx({ user: memory.read({ kind: 'user' }) }))).toEqual([]);
  });

  it('a look back at a nearly full memory is told to make room first', async () => {
    const { store, memory, asked, reflection } = setup(answer([]));
    memory.add({ kind: 'user' }, 'x'.repeat(1200), 'you');
    talk(store, 'ws:a', 3);
    await reflection.reflect('ws:a', 'manual');
    expect(asked.calls[0]?.prompt).toContain('Nearly full: the memory about the user (87%)');
    expect(asked.calls[0]?.system).toContain('"forget"');
  });

  it('Tidy looks at every memory at once, with no conversation, and proposes what it found', async () => {
    const store = storeWith();
    const memory = new MemoryStore(homeDir());
    const id = memory.add({ kind: 'user' }, 'Tests in app run with vitest.', 'you').entries[0]!.id;
    memory.add({ kind: 'project', root: '/old/thing' }, 'Uses yarn.', 'you');
    const asked = answering(answer([{ move: id, scope: 'project:1' }, { scope: 'user', text: 'New fact.' }]));
    const reflection = new Reflection({ store, ask: asked.ask, sharedWith: () => false, memory, file: null, now: () => NOW });
    expect(await reflection.tidy()).toEqual({ proposed: 1 });
    expect(asked.calls[0]?.model).toBe('haiku');
    expect(asked.calls[0]?.prompt).toContain('Memory "project:1" (the project app');
    expect(asked.calls[0]?.prompt).toContain('Memory "project:2" (the project thing');
    expect(asked.calls[0]?.prompt).toContain('Uses yarn.');
    expect(store.getState().memoryProposals[0]).toMatchObject({ kind: 'project', root: ROOT, project: 'app', from: { kind: 'user' }, channel: '' });
  });

  it('Tidy says so when there is nothing to tidy, and the words fit each outcome', async () => {
    const { reflection, asked } = setup(answer([]));
    expect(await reflection.tidy()).toMatchObject({ skipped: 'empty' });
    expect(asked.calls).toHaveLength(0);
    expect(tidyWords({ proposed: 0 })).toBe('Your memory is tidy: nothing to merge, forget, move or file away.');
    expect(tidyWords({ proposed: 1 })).toBe('1 way to tidy your memory: see Needs You.');
    expect(PHONE['memory.tidy']).toBe('mac');
  });

  it('waiting merges, forgets and moves survive a restart', () => {
    const file = path.join(homeDir(), 'memory-reflection.json');
    const proposals: MemoryProposal[] = [
      { id: 'a', kind: 'user', text: 'Merged.', entry: 'u1', previous: 'One.', merges: [{ id: 'u2', text: 'Two.' }], channel: '', askedAt: NOW },
      { id: 'b', kind: 'user', text: 'Old.', entry: 'u3', previous: 'Old.', drop: true, channel: '', askedAt: NOW + 1 },
      { id: 'c', kind: 'project', root: ROOT, text: 'Moved.', entry: 'u4', previous: 'Moved.', from: { kind: 'user' }, channel: '', askedAt: NOW + 2 },
      { id: 'd', kind: 'user', text: 'Broken.', drop: true, channel: '', askedAt: NOW + 3 },
    ];
    writeFileSync(file, JSON.stringify({ proposals, discarded: [], ran: [] }));
    expect(loadReflection(file).proposals).toEqual(proposals.slice(0, 3));
  });
});

describe('a restart', () => {
  it('keeps what waits, what was discarded and how far each conversation was looked back at, 0600', async () => {
    const file = path.join(homeDir(), 'memory-reflection.json');
    const first = setup(answer([{ scope: 'user', text: 'Prefers pnpm over npm.' }, { scope: 'user', text: 'Likes short answers.' }]), file);
    const lines = Array.from({ length: 6 }, (_, i) => said('ws:a', `Line ${i}`, i % 2 === 1));
    const latest = NOW + n;
    for (const line of lines) first.store.dispatch(line);
    const stop = first.reflection.start();
    await first.reflection.reflect('ws:a', 'manual');
    first.reflection.discard(first.store.getState().memoryProposals[1]!.id);
    stop();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadReflection(file)).toMatchObject({ discarded: ['Likes short answers.'], ran: [], covered: { 'ws:a': latest } });

    const store = storeWith();
    for (const line of lines) store.dispatch(line);
    const asked = answering(answer([]));
    const again = new Reflection({ store, ask: asked.ask, sharedWith: () => false, memory: first.memory, file });
    expect(store.getState().memoryProposals.map((p) => p.text)).toEqual(['Prefers pnpm over npm.']);
    expect(await again.reflect('ws:a', 'manual')).toMatchObject({ skipped: 'nothing_new' });
    expect(asked.calls).toHaveLength(0);
  });

  it('never loads a proposal that holds a secret', () => {
    const file = path.join(homeDir(), 'memory-reflection.json');
    const bad: MemoryProposal = { id: 'x', kind: 'user', text: 'password = hunter22', channel: 'ws:a', askedAt: NOW };
    const good: MemoryProposal = { id: 'y', kind: 'user', text: 'Likes tabs.', channel: 'ws:a', askedAt: NOW };
    const raw = JSON.stringify({ proposals: [bad, good], discarded: [], ran: [] });
    writeFileSync(file, raw);
    expect(loadReflection(file).proposals.map((p) => p.id)).toEqual(['y']);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });
});
