import { describe, expect, it } from 'vitest';
import { chatPeople, claudeLine, claudePill, offlineNote, versionChip, waitingIn, waitingLabel } from '../src/core/chat-people.js';
import type { TaskView } from '../src/core/gateway/model.js';
import type { MessageView, PersonView } from '../src/net/mesh/views.js';
import { runPlaces } from '../packages/mac/src/network/chat-model.js';

/** Who's who in a chat with friends and what waits on whom (BLG-210): src/core/chat-people.ts, and runs of messages. */

const id = (c: string): string => c.repeat(32);
const CHAT = 'group:' + 'f'.repeat(32);
const person = (name: string, extra: Partial<PersonView> = {}): PersonView => ({ peerId: id(name[0]!.toLowerCase()), name, online: true, presence: { state: 'online' }, beluga: { version: '1.3.0', can: [] }, ...extra });
const task = (extra: Partial<TaskView>): TaskView => ({
  id: 't1',
  direction: 'sent',
  peerId: id('a'),
  peerName: 'Ata',
  kind: 'ask',
  ask: 'Run the tests in ata-api and tell me what fails',
  summary: 'run tests in ata-api',
  needs: [],
  by: 'agent',
  chat: CHAT,
  state: 'working',
  steps: [],
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const me = { peerId: id('k'), name: 'Kayra', version: '1.3.0+mac.1.3.0' };
const msg = (from: string, ts: number, extra: Partial<MessageView> = {}): MessageView => ({ id: `${from}${ts}`, conversation: CHAT, from, name: from, text: 'hi', ts, mine: false, ...extra });

describe('the people in a chat and their Claudes', () => {
  it('puts you first, then says what each Claude does: working, idle, offline, needs an update', () => {
    const people = chatPeople({
      conversation: CHAT,
      self: me,
      others: [person('Ata'), person('Bo'), person('Mia', { online: false, beluga: { version: '1.1.0', can: [] } }), person('Zed', { update: 'them' })],
      tasks: [task({})],
      live: [{ peerId: id('b'), name: 'Bo', for: 'm1', since: 0 }],
      myRun: { working: true, doing: "reading Ata's notes" },
    });
    expect(people.map((p) => [p.name, p.me, p.claude])).toEqual([
      ['Kayra', true, 'working'],
      ['Ata', false, 'working'],
      ['Bo', false, 'working'],
      ['Mia', false, 'offline'],
      ['Zed', false, 'update'],
    ]);
    expect(people.map(claudePill)).toEqual(['working', 'working', 'working', 'offline · 1.1.0', 'needs an update']);
    expect(people[0]!.doing).toBe("reading Ata's notes");
    expect(people[1]!.doing).toBe('run tests in ata-api');
    expect(people[0]!.version).toBe('1.3.0');
  });

  it('says which agent each person runs, from their room card (BLG-80)', () => {
    const codex = { runtime: 'codex', label: 'Codex', model: 'gpt-5' } as const;
    const people = chatPeople({ conversation: CHAT, self: { ...me, agent: codex }, others: [person('Ata'), person('Bo')], peers: [{ peerId: id('a'), defaultAgent: { runtime: 'claude', label: 'Claude', model: 'opus' } }], tasks: [] });
    expect(people.map((p) => p.agent)).toEqual([codex, { runtime: 'claude', label: 'Claude', model: 'opus' }, undefined]);
  });

  it('is idle when nothing runs here (a finished task, or one in another chat, doesn’t count)', () => {
    const people = chatPeople({ conversation: CHAT, self: me, others: [person('Ata')], tasks: [task({ state: 'done' }), task({ id: 't2', chat: 'dm:x', conversation: 'dm:x' })] });
    expect(people.map((p) => p.claude)).toEqual(['idle', 'idle']);
  });

  it('counts your Claude working on a friend’s request here as working', () => {
    const [mine] = chatPeople({ conversation: CHAT, self: me, others: [], tasks: [task({ direction: 'received', state: 'working' })] });
    expect(mine).toMatchObject({ claude: 'working', doing: 'run tests in ata-api for Ata' });
  });

  it('says it for the panel, with trust, the version or what they need', () => {
    expect(claudeLine({ me: true, claude: 'working', doing: "reading Ata's notes" })).toBe("Agent: reading Ata's notes");
    expect(claudeLine({ me: false, claude: 'idle' })).toBe('Agent idle');
    expect(claudeLine({ me: false, claude: 'offline' })).toBe('Offline · messages wait');
    expect(claudeLine({ me: false, claude: 'working', doing: 'answering' })).toBe('Agent answering');
    expect(versionChip({ version: '1.3.0' })).toEqual({ text: '1.3.0', behind: false });
    expect(versionChip({ update: 'them' }, '1.3.2+mac.1.3.2')).toEqual({ text: 'needs 1.3', behind: true });
    expect(versionChip({ update: 'you' })).toEqual({ text: 'update yours', behind: true });
    expect(versionChip({})).toBeUndefined();
  });

  it('notes who won’t get a message now, never guessing pronouns', () => {
    expect(offlineNote([{ name: 'You', me: true, claude: 'idle' }, { name: 'Ata', me: false, claude: 'idle' }])).toBeUndefined();
    expect(offlineNote([{ name: 'Mia', me: false, claude: 'offline' }])).toBe('Mia is offline: this waits for them');
    expect(offlineNote([{ name: 'Mia', me: false, claude: 'offline' }, { name: 'Zed', me: false, claude: 'update' }])).toBe('Mia and Zed are offline: this waits for them');
    expect(offlineNote(['A', 'B', 'C'].map((name) => ({ name, me: false, claude: 'offline' as const })))).toBe('3 people are offline: this waits for them');
  });
});

describe('what waits on whom', () => {
  const secret = task({ id: 's1', direction: 'received', kind: 'file', state: 'awaiting_approval', path: '~/.ssh/id_ed25519', secret: { kind: 'ssh-key', label: 'your private SSH key id_ed25519' } });

  it('lists what waits on you first, then on the others, each pointing at its card', () => {
    const waiting = waitingIn({
      conversation: CHAT,
      tasks: [task({ id: 'r1', state: 'awaiting_approval' }), secret, task({ id: 'c1', state: 'confirm', chat: undefined, conversation: CHAT }), task({ id: 'gone', state: 'done' })],
      approvals: [
        { id: 'a1', title: 'Run npm test', channel: CHAT },
        { id: 'a2', title: 'A friend’s request', channel: CHAT, task: 's1' },
        { id: 'a3', title: 'Elsewhere', channel: 'ws:w1' },
      ],
    });
    expect(waiting.map(waitingLabel)).toEqual([
      'Waiting on you: Ata’s agent wants your private SSH key id_ed25519',
      'Waiting on you: Your agent wants to ask Ata’s agent',
      'Waiting on you: Your agent: Run npm test',
      'Waiting on Ata: run tests in ata-api',
    ]);
    expect(waiting.map((w) => w.kind)).toEqual(['secret', 'confirm', 'approval', 'request']);
    expect(waiting[0]!.target).toEqual({ kind: 'task', id: 's1' });
    expect(waiting[2]!.target).toEqual({ kind: 'attention', id: 'a1' });
  });

  it('says what a friend’s request wants, and their Claude’s question', () => {
    const waiting = waitingIn({
      conversation: CHAT,
      tasks: [
        task({ id: 'x', direction: 'received', kind: 'run', command: 'npm test', state: 'awaiting_approval', by: 'person' }),
        task({ id: 'q', question: { qid: 'q1', askedAt: 0, questions: [{ question: 'Which branch?', header: '', options: [], multiSelect: false }] } }),
      ],
    });
    expect(waiting.map(waitingLabel)).toEqual(['Waiting on you: Ata wants to run npm test', 'Waiting on you: Ata’s agent asks: Which branch?']);
  });

  it('is empty when nothing waits (the band hides)', () => {
    expect(waitingIn({ conversation: CHAT, tasks: [task({})] })).toEqual([]);
  });
});

describe('runs of messages', () => {
  it('groups one person’s messages within a few minutes: the first has the name, the last the picture', () => {
    const list = [msg('a', 0), msg('a', 60_000), msg('a', 120_000), msg('b', 130_000), msg('a', 140_000), msg('a', 20 * 60_000)];
    expect(runPlaces(list)).toEqual([
      { first: true, last: false },
      { first: false, last: false },
      { first: false, last: true },
      { first: true, last: true },
      { first: true, last: true },
      { first: true, last: true },
    ]);
  });

  it('keeps a person and their Claude apart, and a task’s card on its own', () => {
    const list = [msg('a', 0), msg('a', 1000, { claude: { for: 'x' } }), msg('a', 2000, { task: { id: 't', role: 'request' } }), msg('a', 3000)];
    expect(runPlaces(list).map((p) => p.first && p.last)).toEqual([true, true, true, true]);
  });
});
