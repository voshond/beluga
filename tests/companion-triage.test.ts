import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PhoneCalls } from '../src/companion/calls.js';
import { RefTable } from '../src/companion/files.js';
import { COMPANION_PROTO, ConvSummary, SINCE, WorkView } from '../src/companion/protocol.js';
import { type ViewContext, needsYou, viewOf, workView } from '../src/companion/views.js';
import type { PendingQuestion } from '../src/core/collab-store.js';
import { Store, initialState } from '../src/core/store.js';
import { TriageService } from '../src/core/triage/service.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { calls } from '../packages/companion/lib/link/calls.js';
import { categorySections, settledWords, triageOptions } from '../packages/companion/lib/triage.js';

/** The categories on the phone (BLG-74): what Work carries, the sheet's rows and what a call changes. */

const HOUR = 3_600_000;
const TOPIC = 'conv:ws:w1' as const;
const ws = (id: string): Workspace => ({ id, projectId: 'p1', projectRoot: '/tmp/app', name: id, path: `/tmp/app-${id}`, kind: 'worktree', createdAt: Date.now() - HOUR, external: false }) as Workspace;
const project = { id: 'p1', name: 'app', root: '/tmp/app', base: 'main', workspaces: [ws('w1'), ws('w2')] } as Project;
const ctx: ViewContext = { refs: new RefTable(() => 'ref00001'), mac: { name: 'Mac', version: '1' } };
const question: PendingQuestion = { qid: 'q1', requestId: 'q1', owner: 'me', channel: 'ws:w1', picked: {}, question: { kind: 'question', questions: [{ question: 'Which?', header: '', options: [], multiSelect: false }] } };

let dir: string;
let services: TriageService[];

function setup(on = true): { store: Store; service: TriageService } {
  const store = new Store({ ...initialState('room', 'ask', { chatCategories: on }), projects: [project], self: { peerId: 'me', name: 'rob' } as never, selfId: 'me' });
  const service = new TriageService({ store, file: path.join(dir, 'triage.json'), notify: () => undefined, history: () => [] });
  services.push(service);
  return { store, service };
}

const summaries = (store: Store) => workView(store.getState(), ctx).projects.flatMap((p) => p.conversations);
const summary = (store: Store, topic: string = TOPIC) => summaries(store).find((c) => c.topic === topic)!;

/** Make a phone's call on the service the way the host routes it. */
function phoneCalls(service: TriageService, call: { method: string; args: readonly unknown[] }): void {
  const [channel, until] = call.args as [string, number];
  if (call.method === 'triage.settle') service.settle(channel);
  else if (call.method === 'triage.unsettle') service.unsettle(channel);
  else if (call.method === 'triage.snooze') service.snooze(channel, until);
  else if (call.method === 'triage.wake') service.wake(channel);
  else throw new Error(`not a triage call: ${call.method}`);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'phone-triage-'));
  services = [];
});

afterEach(() => {
  for (const s of services) s.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('Work with chatCategories off', () => {
  it('carries no category field at all, and not `categories`', () => {
    const { store } = setup(false);
    const view = workView(store.getState(), ctx);
    expect(view).not.toHaveProperty('categories');
    for (const c of view.projects.flatMap((p) => p.conversations)) for (const field of ['category', 'snoozedUntil', 'settledWhy', 'back']) expect(c).not.toHaveProperty(field);
  });

  it('ignores records that stay on disk from when it was on', () => {
    const { store, service } = setup(true);
    service.settle('ws:w1');
    store.dispatch({ type: 'prefs', prefs: { chatCategories: false } } as never);
    expect(summary(store)).not.toHaveProperty('category');
    expect(summary(store)).not.toHaveProperty('settledWhy');
  });
});

describe('Work with chatCategories on', () => {
  it('says so, and each chat has its category', () => {
    const { store } = setup();
    const view = workView(store.getState(), ctx);
    expect(view.categories).toBe(true);
    expect(WorkView.safeParse(view).success).toBe(true);
    expect(summary(store).category).toBe('active');
  });

  it('a snoozed chat carries its wake time', () => {
    const { store, service } = setup();
    const until = Date.now() + HOUR;
    service.snooze('ws:w1', until);
    expect(summary(store)).toMatchObject({ category: 'snoozed', snoozedUntil: until });
    expect(summary(store)).not.toHaveProperty('back');
    expect(WorkView.safeParse(workView(store.getState(), ctx)).success).toBe(true);
  });

  it('a woken chat is Active and Back, without its old wake time', () => {
    const { store, service } = setup();
    service.snooze('ws:w1', Date.now() + HOUR);
    service.wake('ws:w1');
    expect(summary(store)).toMatchObject({ category: 'active', back: true });
    expect(summary(store)).not.toHaveProperty('snoozedUntil');
  });

  it('a settled chat carries why', () => {
    const { store, service } = setup();
    service.settle('ws:w1');
    expect(summary(store)).toMatchObject({ category: 'settled', settledWhy: 'you' });
  });

  it('a running turn is Working', () => {
    const { store } = setup();
    store.dispatch({ type: 'agent_event', owner: 'me', requestId: 'r1', requester: 'me', event: 'started', text: '', ts: Date.now(), channel: 'ws:w1', itemId: 'i1' });
    expect(summary(store).category).toBe('working');
  });

  it('what has no category (the room) has no field, and stays listed', () => {
    const { store } = setup();
    store.dispatch({ type: 'chat', id: 'c1', from: 'bob', text: 'hi', ts: Date.now(), byAgent: false, channel: 'room' });
    const room = summary(store, 'conv:room');
    expect(room).toBeDefined();
    expect(room).not.toHaveProperty('category');
    expect(categorySections([{ id: 'room', name: 'The room', conversations: [room] }]).active[0]?.conversations).toEqual([room]);
  });

  it('a snoozed question stays in NeedsYou, so the phone can still answer it', () => {
    const { store, service } = setup();
    store.dispatch({ type: 'question_add', question } as never);
    service.snooze('ws:w1', Date.now() + HOUR);
    expect(summary(store)).toMatchObject({ category: 'snoozed', needsYou: true });
    expect(needsYou(store.getState()).some((n) => n.topic === TOPIC)).toBe(true);
  });

  it('Home and a conversation stay as they were: only Work carries it', () => {
    const { store, service } = setup();
    service.settle('ws:w1');
    expect(JSON.stringify(viewOf(store.getState(), ctx, 'home'))).not.toContain('settledWhy');
    expect(JSON.stringify(viewOf(store.getState(), ctx, TOPIC))).not.toContain('settledWhy');
  });
});

describe('an older phone', () => {
  it('has the triage minor to check, a raised protocol', () => {
    expect(SINCE.triage).toBe(48);
    expect(COMPANION_PROTO.minor).toBeGreaterThanOrEqual(SINCE.triage);
  });

  it('still reads a valid Work with the fields it does not know', () => {
    const { store, service } = setup();
    service.settle('ws:w1');
    const older = z.object({ projects: z.array(z.object({ conversations: z.array(ConvSummary.omit({ category: true, snoozedUntil: true, settledWhy: true, back: true })) })) });
    const read = older.parse(workView(store.getState(), ctx));
    expect(read.projects[0]?.conversations.map((c) => c.topic)).toContain(TOPIC);
    expect(read).not.toHaveProperty('categories');
  });

  it('a Mac without the fields parses for this phone, as today', () => {
    const { store } = setup(false);
    const view = WorkView.parse(workView(store.getState(), ctx));
    expect(view.categories).toBeUndefined();
  });
});

describe('the phone’s calls', () => {
  it('Settle calls triage.settle on the channel, and the chat moves to Settled for both screens', () => {
    const { store, service } = setup();
    const call = calls.settle(TOPIC);
    expect(call).toMatchObject({ method: 'triage.settle', args: ['ws:w1'] });
    expect(PhoneCalls['triage.settle'].args.safeParse(call.args).success).toBe(true);
    phoneCalls(service, call);
    // The Mac reads the same record; the phone's view and sections come from it.
    expect(store.getState().triage['ws:w1']?.settled?.why).toBe('you');
    expect(summary(store).category).toBe('settled');
    const sections = categorySections(workView(store.getState(), ctx).projects);
    expect(sections.settled.map((c) => c.topic)).toEqual([TOPIC]);
    expect(sections.active.flatMap((p) => p.conversations).map((c) => c.topic)).not.toContain(TOPIC);
  });

  it('Snooze, Wake and Un-settle reach the service', () => {
    const { store, service } = setup();
    const until = Date.now() + HOUR;
    expect(calls.snooze(TOPIC, until)).toMatchObject({ method: 'triage.snooze', args: ['ws:w1', until] });
    phoneCalls(service, calls.snooze(TOPIC, until));
    expect(summary(store).category).toBe('snoozed');
    phoneCalls(service, calls.wake(TOPIC));
    expect(summary(store).category).toBe('active');
    phoneCalls(service, calls.settle(TOPIC));
    phoneCalls(service, calls.unsettle(TOPIC));
    expect(summary(store).category).toBe('active');
  });

  it('never changes the setting: no phone call or sheet row does', () => {
    expect(Object.keys(calls).filter((k) => /categor|setting|pref/i.test(k))).toEqual([]);
    for (const category of ['active', 'working', 'snoozed', 'settled'] as const) expect(triageOptions({ category }).join()).not.toMatch(/categor|setting/i);
  });
});

describe('the Work tab’s model', () => {
  const conv = (topic: string, category?: ConvSummary['category'], lastAt = 1): ConvSummary => ({ topic: `conv:ws:${topic}` as ConvSummary['topic'], title: topic, status: 'idle', lastAt, ...(category ? { category } : {}) });

  it('Active keeps the project groups; the others are one list each, newest first', () => {
    const sections = categorySections([
      { id: 'p1', name: 'one', conversations: [conv('a', 'active'), conv('b', 'settled', 1), conv('c', 'working')] },
      { id: 'p2', name: 'two', conversations: [conv('d', 'settled', 2), conv('e', 'snoozed')] },
    ]);
    expect(sections.active.map((p) => [p.id, p.conversations.map((c) => c.title)])).toEqual([['p1', ['a']]]);
    expect(sections.working.map((c) => c.title)).toEqual(['c']);
    expect(sections.snoozed.map((c) => c.title)).toEqual(['e']);
    expect(sections.settled.map((c) => c.title)).toEqual(['d', 'b']);
  });

  it('the sheet offers what the category can do', () => {
    expect(triageOptions({ category: 'active' })).toEqual(['settle', 'snooze']);
    expect(triageOptions({ category: 'working' })).toEqual(['snooze']);
    expect(triageOptions({ category: 'snoozed' })).toEqual(['wake']);
    expect(triageOptions({ category: 'settled' })).toEqual(['unsettle']);
    expect(triageOptions({})).toEqual([]);
  });

  it('says why a chat settled', () => {
    expect(settledWords('you')).toBe('Settled by you');
    expect(settledWords('pr_merged')).toBe('PR merged');
    expect(settledWords('merged_here')).toBe('Merged here');
    expect(settledWords('idle')).toBe('Idle for days');
    expect(settledWords(undefined)).toBe('Settled');
  });
});
