import { describe, expect, it } from 'vitest';
import { runMarkdown } from '../src/core/plans/decisions.js';
import { QuestionBroker } from '../src/core/questions.js';
import { plainOutput, promptIn, runAnswer, runAskIn, runTarget, runnableQuestion, scrubbed } from '../src/core/run-ask.js';
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
    expect(runAskIn('Restart it.\n\nRun on **nas**:\n```sh\ncd /volume1/docker\nsudo docker compose up -d\n```\nIt worked when: up')).toEqual({ on: 'nas', commands: ['cd /volume1/docker', 'sudo docker compose up -d'] });
  });

  it('runs here without a machine line', () => {
    expect(runAskIn('```bash\nls\n```')).toEqual({ commands: ['ls'] });
  });

  it('round-trips what a plan card shows', () => {
    expect(runAskIn(runMarkdown({ on: 'arch', cwd: '/home/me/repo', commands: ['npm ci'] }))).toEqual({ on: 'arch', commands: ['cd /home/me/repo', 'npm ci'] });
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
    expect(runAnswer({ status: 'done', where: 'nas', output: 'ok\n', startedAt: 0, exit: 0 })).toBe('I ran it through Beluga on nas: exit code 0. Output:\n```text\nok\n```');
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
