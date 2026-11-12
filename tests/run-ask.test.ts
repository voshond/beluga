import { describe, expect, it } from 'vitest';
import { QuestionBroker } from '../src/core/questions.js';
import { isRunCard, plainOutput, promptIn, runAnswer, runAskIn, runCard, runCardResult, runMarkdown, runTarget, runnableQuestion, scrubbed } from '../src/core/run-ask.js';
import { RunAsks } from '../src/core/run-asks.js';
import { Store, initialState } from '../src/core/store.js';
import type { ClaudeAnswer } from '../src/protocol.js';
import type { IPty } from '../src/terminal/pty.js';

const SELF = 'p-me';

const card = (question: string, owner = SELF, qid = 'q1') => ({ qid, requestId: 'r1', owner, channel: 'ws:one', question: { kind: 'question' as const, questions: [{ question, header: '', options: [{ label: 'Done', description: '' }], multiSelect: false }] }, picked: {} });

type FakePty = {
  readonly pty: IPty;
  readonly written: string[];
  emit: (data: string) => void;
  exit: (code: number) => void;
  killed: () => boolean;
};

const fakePty = (): FakePty => {
  const written: string[] = [];
  let onData: (d: string) => void = () => undefined;
  let onExit: (e: { exitCode: number }) => void = () => undefined;
  let killed = false;
  const pty = {
    onData: (cb: (d: string) => void) => {
      onData = cb;
      return { dispose: () => undefined };
    },
    onExit: (cb: (e: { exitCode: number }) => void) => {
      onExit = cb;
      return { dispose: () => undefined };
    },
    write: (d: string) => void written.push(d),
    kill: () => {
      killed = true;
    },
  } as unknown as IPty;
  return { pty, written, emit: (d) => onData(d), exit: (code) => onExit({ exitCode: code }), killed: () => killed };
};

const setup = (question: string, owner = SELF) => {
  const store = new Store(initialState('room'));
  const answers: ClaudeAnswer[] = [];
  const broker = new QuestionBroker({ store, selfId: () => SELF, send: () => true, timeoutMs: () => 60_000, toast: () => undefined });
  broker.pose('q1', 'ws:one', card(question, owner).question, (a) => void answers.push(a));
  if (owner !== SELF) store.dispatch({ type: 'question_remove', qid: 'q1' });
  if (owner !== SELF) store.dispatch({ type: 'question_add', question: card(question, owner) });
  const fake = fakePty();
  const spawned: Array<{ file: string; args: readonly string[] }> = [];
  const runs = new RunAsks({
    store,
    selfId: () => SELF,
    sshHosts: async () => ['nas', 'arch'],
    hostname: () => 'i9arch',
    answer: (qid, q, text) => broker.answerPart(qid, q, text),
    spawn: (file, args) => {
      spawned.push({ file, args });
      return fake.pty;
    },
  });
  return { store, answers, runs, fake, spawned };
};

describe('runAskIn', () => {
  it('reads the machine and the commands of the one sh block', () => {
    expect(runAskIn('Restart it.\n\nRun on **nas**:\n```sh\ncd /volume1/docker\nsudo docker compose up -d\n```\nIt worked when: up')).toEqual({ on: 'nas', commands: ['cd /volume1/docker', 'sudo docker compose up -d'], expect: 'up' });
  });

  it('runs here without a machine line', () => {
    expect(runAskIn('```bash\nls\n```')).toEqual({ commands: ['ls'] });
  });

  it('round-trips what a plan card shows', () => {
    expect(runAskIn(runMarkdown({ on: 'arch', cwd: '/home/me/repo', commands: ['npm ci'] }))).toEqual({ on: 'arch', commands: ['cd /home/me/repo', 'npm ci'] });
    expect(runAskIn(runMarkdown({ on: 'arch', commands: ['npm ci'], expect: 'added 120 packages' }))?.expect).toBe('added 120 packages');
  });

  it('runs nothing that is ambiguous, untagged, a console transcript or cut off', () => {
    expect(runAskIn('```sh\na\n```\n```sh\nb\n```')).toBeUndefined();
    expect(runAskIn('```\nls\n```')).toBeUndefined();
    expect(runAskIn('```console\n$ ls\n```')).toBeUndefined();
    expect(runAskIn('```sh\nrm -rf /tmp/x/…')).toBeUndefined();
  });

  it('is only for your own agent and the question shown', () => {
    const md = '```sh\nls\n```';
    expect(runnableQuestion(card(md), SELF, md)).toEqual({ commands: ['ls'] });
    expect(runnableQuestion(card(md, 'p-friend'), SELF, md)).toBeUndefined();
    expect(runnableQuestion(card(md), SELF, '```sh\nrm -rf ~\n```')).toBeUndefined();
  });
});

describe('runTarget', () => {
  it('runs here for this machine, by any name for it', () => {
    expect(runTarget(undefined, 'i9arch', [])).toEqual({ kind: 'local', where: 'i9arch' });
    expect(runTarget('i9arch', 'i9arch', ['nas'])?.kind).toBe('local');
    expect(runTarget('this machine', 'i9arch', [])?.kind).toBe('local');
  });

  it('finds an SSH Host, however the agent wrote it', () => {
    expect(runTarget('the NAS', 'i9arch', ['nas'])).toEqual({ kind: 'ssh', host: 'nas', where: 'nas' });
    expect(runTarget('arch (main computer)', 'i9arch', ['arch'])).toEqual({ kind: 'ssh', host: 'arch', where: 'arch' });
    expect(runTarget('m1arch', 'i9arch', ['nas'])).toBeUndefined();
  });
});

describe('output', () => {
  it('drops colours and carriage-return redraws', () => {
    expect(plainOutput('\u001b[32mok\u001b[0m\r\n10%\r50%\r100%\n')).toBe('ok\n100%\n');
  });

  it('spots a password prompt and a yes/no', () => {
    expect(promptIn('hi\n[sudo] password for voshond: ')).toEqual({ text: '[sudo] password for voshond:', secret: true });
    expect(promptIn('Are you sure you want to continue connecting (yes/no/[fingerprint])? ')?.secret).toBe(false);
    expect(promptIn('building…')).toBeUndefined();
  });

  it('never keeps what you typed as a secret', () => {
    expect(scrubbed('oops hunter2 shown', ['hunter2'])).toBe('oops •••• shown');
  });

  it('answers with the exit code and the output', () => {
    expect(runAnswer({ status: 'done', where: 'nas', output: 'ok\n', startedAt: 0, exit: 0 })).toBe('I ran it through Beluga on nas: exit code 0. Check the output and decide whether it worked. Output:\n```text\nok\n```');
    expect(runAnswer({ status: 'failed', where: 'nas', output: '', startedAt: 0, exit: 1 }, 'both containers say Started')).toBe('I ran it through Beluga on nas: exit code 1. Check the output against what success looks like (both containers say Started) and decide whether it worked. It printed nothing.');
  });
});

describe('RunAsks', () => {
  it('runs over ssh, takes the password, and answers the card with what it printed', async () => {
    const { store, answers, runs, fake, spawned } = setup('Run on **nas**:\n```sh\nsudo systemctl restart x\n```');
    const question = store.getState().questions[0]!.question;
    const text = question.kind === 'question' ? question.questions[0]!.question : '';
    await runs.start('q1', text);
    expect(spawned[0]).toEqual({ file: 'ssh', args: ['-t', 'nas', 'set -e\nsudo systemctl restart x'] });
    fake.emit('[sudo] password for me: ');
    expect(store.getState().runAsks.q1?.prompt).toEqual({ text: '[sudo] password for me:', secret: true });
    runs.input('q1', 'hunter2');
    expect(fake.written).toEqual(['hunter2\r']);
    expect(store.getState().runAsks.q1?.prompt).toBeUndefined();
    fake.emit('\r\nhunter2 restarted\r\n');
    fake.exit(0);
    expect(answers).toHaveLength(1);
    const answer = answers[0]!;
    const said = answer.kind === 'answers' ? Object.values(answer.answers)[0] : '';
    expect(said).toContain('on nas: exit code 0');
    expect(said).toContain('•••• restarted');
    expect(said).not.toContain('hunter2');
    expect(store.getState().questions).toHaveLength(0);
    expect(store.getState().runAsks).toEqual({});
  });

  it('a stopped run leaves the card waiting', async () => {
    const { store, answers, runs, fake } = setup('```sh\nsleep 100\n```');
    await runs.start('q1', '```sh\nsleep 100\n```');
    runs.stop('q1');
    expect(fake.killed()).toBe(true);
    fake.exit(143);
    expect(answers).toHaveLength(0);
    expect(store.getState().runAsks.q1?.status).toBe('stopped');
    expect(store.getState().questions).toHaveLength(1);
  });

  it('refuses a friend’s agent and an unknown machine', async () => {
    const friend = setup('```sh\nls\n```', 'p-friend');
    await expect(friend.runs.start('q1', '```sh\nls\n```')).rejects.toThrow(/your own agent/);
    const far = setup('Run on **m1arch**:\n```sh\nls\n```');
    await expect(far.runs.start('q1', 'Run on **m1arch**:\n```sh\nls\n```')).rejects.toThrow(/can’t reach “m1arch”/);
    expect(far.spawned).toHaveLength(0);
  });
});

describe('run cards (run_for_me)', () => {
  const DEPLOY = { on: 'nas', cwd: '/volume1/docker/registry', commands: ['sudo docker compose up -d'], expect: 'both containers say Started' };

  it('puts why above the commands, with no options', () => {
    const q = runCard('The registry runs an old image.', DEPLOY);
    expect(q).toEqual({
      kind: 'question',
      questions: [{ question: 'The registry runs an old image.\n\nRun on **nas**:\n```sh\ncd /volume1/docker/registry\nsudo docker compose up -d\n```\nIt worked when: both containers say Started', header: 'Run this for me', options: [], multiSelect: false }],
    });
    expect(typeof q !== 'string' && isRunCard(q)).toBe(true);
    expect(typeof q !== 'string' && q.kind === 'question' && runAskIn(q.questions[0]!.question)).toEqual({ on: 'nas', commands: ['cd /volume1/docker/registry', 'sudo docker compose up -d'], expect: 'both containers say Started' });
  });

  it('says why it can’t make one', () => {
    expect(runCard('  ', { commands: ['ls'] })).toMatch(/Say why/);
    expect(runCard('why', { commands: ['  ', ''] })).toMatch(/at least one command/);
    expect(runCard('why', { commands: ['```sh', 'ls', '```'] })).toMatch(/without a code fence/);
    expect(runCard('x'.repeat(990), { commands: ['ls'] })).toMatch(/a card holds 1000/);
    expect(runCard('First this:\n```sh\nls\n```', { commands: ['pwd'] })).toMatch(/out of why/);
    expect(runCard('Run on **arch** first.', { on: 'nas', commands: ['pwd'] })).toMatch(/out of why/);
  });

  it('is never a question Claude asked with options', () => {
    expect(isRunCard(card('```sh\nls\n```').question)).toBe(false);
    expect(isRunCard({ kind: 'question', questions: [{ question: 'Which one?', header: '', options: [], multiSelect: false }] })).toBe(false);
    expect(isRunCard({ kind: 'plan', plan: '```sh\nls\n```' })).toBe(false);
  });

  it('tells the agent what came of it', () => {
    expect(runCardResult({ kind: 'skip' })).toMatch(/skipped it: nothing was run/);
    expect(runCardResult({ kind: 'answers', answers: { q: 'I ran it through Beluga on nas: exit code 0.' } })).toBe('I ran it through Beluga on nas: exit code 0.');
    expect(runCardResult({ kind: 'answers', answers: { q: 'did it in my own terminal' } })).toBe("The user didn't run it through Beluga and answered instead: did it in my own terminal");
  });

  it('a Run answers the agent waiting on the card', async () => {
    const store = new Store(initialState('room'));
    const broker = new QuestionBroker({ store, selfId: () => SELF, send: () => true, timeoutMs: () => 60_000, toast: () => undefined });
    const fake = fakePty();
    const runs = new RunAsks({ store, selfId: () => SELF, sshHosts: async () => ['nas'], hostname: () => 'i9arch', answer: (qid, q, text) => broker.answerPart(qid, q, text), spawn: () => fake.pty });
    const q = runCard('Restart it.', { on: 'nas', commands: ['sudo systemctl restart x'] });
    if (typeof q === 'string' || q.kind !== 'question') throw new Error('no card');
    const waiting = broker.ask(SELF, 'r1', 'ws:one', q);
    await runs.start(store.getState().questions[0]!.qid, q.questions[0]!.question);
    fake.emit('restarted\r\n');
    fake.exit(0);
    expect(runCardResult(await waiting)).toContain('on nas: exit code 0');
    expect(store.getState().questions).toHaveLength(0);
  });
});
