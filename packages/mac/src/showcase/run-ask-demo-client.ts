import type { PendingQuestion } from '@beluga/core/collab-store.js';
import { askQuestion } from '@beluga/core/plans/decisions.js';
import { type RunAskState, runAnswer, runnableQuestion } from '@beluga/core/run-ask.js';
import { type AppState, type DomainState, Store, initialState } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { ClaudeAnswer } from '@beluga/protocol.js';

export const DEMO_SELF = 'p-voshond';
export const CHAT_CHANNEL = 'ws:demo-chat';
export const PLAN_CHANNEL = 'plan:demo';

const CHAT_QUESTION = [
  'The registry stack still has the old credentials loaded, so pushes from i9arch get a 401. It needs a pull and a restart on the NAS, and that takes sudo.',
  '',
  'Run on **nas**:',
  '```sh',
  'cd /volume1/docker/arcane/projects/registry',
  'sudo docker compose pull && sudo docker compose up -d',
  '```',
  'It worked when: both containers say Started',
].join('\n');

const chatCard: PendingQuestion = {
  qid: 'demo-chat',
  requestId: 'demo-chat',
  owner: DEMO_SELF,
  channel: CHAT_CHANNEL,
  question: { kind: 'question', questions: [{ question: CHAT_QUESTION, header: 'Needs sudo on the NAS', options: [{ label: 'Done', description: 'Both containers are up' }, { label: 'It failed', description: 'Paste the last lines instead' }], multiSelect: false }] },
  picked: {},
};

const planCard: PendingQuestion = {
  qid: 'ask:demo:ship-registry:1',
  requestId: 'ask:demo:ship-registry:1',
  owner: DEMO_SELF,
  channel: PLAN_CHANNEL,
  question: askQuestion(
    {
      task: 'ship-registry',
      question: 'Install the systemd unit so the worker starts on boot?',
      why: 'It needs sudo on i9arch, which the agent doesn’t have.',
      options: [{ label: 'Done' }, { label: 'Skip it', description: 'Start the worker by hand for now' }],
      recommended: 'Done',
      run: { on: 'i9arch', commands: ['sudo cp deploy/beluga-worker.service /etc/systemd/system/', 'sudo systemctl daemon-reload', 'sudo systemctl enable --now beluga-worker'], expect: 'active (running)' },
      worktree: 'ws:demo-plan',
      at: 1,
    },
    'BLG-31',
    'Ship the registry worker',
  ),
  picked: {},
};

type Script = { readonly before: readonly string[]; readonly after: readonly string[]; readonly prompt: string };

const SCRIPTS: Record<string, Script> = {
  [chatCard.qid]: {
    before: ['$ ssh nas\n'],
    prompt: '[sudo] password for voshond: ',
    after: [
      '\n[+] Pulling 2/2\n',
      ...Array.from({ length: 18 }, (_, i) => ` ✔ ${(0x3f1a2c + i * 7919).toString(16)}e7 Pull complete            ${(0.2 + i * 0.07).toFixed(1)}s\n`),
      ' ✔ registry Pulled                1.8s\n',
      ' ✔ registry-ui Pulled             1.2s\n', '[+] Running 2/2\n', ' ✔ Container registry     Started  0.6s\n', ' ✔ Container registry-ui  Started  0.4s\n'],
  },
  [planCard.qid]: {
    before: [],
    prompt: '[sudo] password for voshond: ',
    after: ['\nCreated symlink /etc/systemd/system/multi-user.target.wants/beluga-worker.service → /etc/systemd/system/beluga-worker.service.\n', '● beluga-worker.service - Beluga registry worker\n', '     Active: active (running) since Sun 2026-11-08 10:41:12 CET; 12ms ago\n'],
  },
};

export type DemoAnswer = { readonly channel: string; readonly text: string };

export const makeDemoClient = (onAnswer: (answer: DemoAnswer) => void): SocketClient => {
  const store = new Store({ ...initialState('room'), selfId: DEMO_SELF });
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const stopped = new Set<string>();
  const waiting = new Map<string, () => void>();

  const setRun = (qid: string, state: RunAskState): void => store.dispatch({ type: 'run_ask', qid, state });
  const runOf = (qid: string): RunAskState | undefined => store.getState().runAsks[qid];

  const stream = async (qid: string, chunks: readonly string[]): Promise<boolean> => {
    for (const chunk of chunks) {
      await sleep(chunks.length > 8 ? 140 : 420);
      const now = runOf(qid);
      if (!now || stopped.has(qid)) return false;
      setRun(qid, { ...now, output: now.output + chunk });
    }
    return true;
  };

  const answer = (qid: string, value: ClaudeAnswer): void => {
    const q = store.getState().questions.find((x) => x.qid === qid);
    store.dispatch({ type: 'question_remove', qid });
    if (q && value.kind === 'answers') onAnswer({ channel: q.channel, text: Object.values(value.answers).join('\n') });
  };

  const run = async (qid: string, question: string): Promise<void> => {
    const q = store.getState().questions.find((x) => x.qid === qid);
    const target = q ? runnableQuestion(q, DEMO_SELF, question) : undefined;
    const script = SCRIPTS[qid];
    if (!q || !target || !script) throw new Error('Nothing to run here');
    stopped.delete(qid);
    setRun(qid, { status: 'running', where: target.on ?? 'i9arch', output: '', startedAt: Date.now() });
    if (!(await stream(qid, [...script.before, script.prompt]))) return;
    const asked = runOf(qid)!;
    setRun(qid, { ...asked, prompt: { text: script.prompt.trim(), secret: true } });
    await new Promise<void>((resolve) => waiting.set(qid, resolve));
    if (!(await stream(qid, script.after))) return;
    const { prompt: _prompt, ...last } = runOf(qid)!;
    const done: RunAskState = { ...last, status: 'done', exit: 0 };
    setRun(qid, done);
    await sleep(1600);
    store.dispatch({ type: 'question_pick', qid, question, answer: runAnswer(done, target.expect) });
    answer(qid, { kind: 'answers', answers: { [question]: runAnswer(done, target.expect) } });
  };

  const api = {
    questions: {
      run,
      runInput: async (qid: string) => {
        const now = runOf(qid);
        if (now) {
          const { prompt: _prompt, ...rest } = now;
          setRun(qid, { ...rest, output: `${now.output}\n` });
        }
        waiting.get(qid)?.();
        waiting.delete(qid);
      },
      runStop: async (qid: string) => {
        stopped.add(qid);
        waiting.delete(qid);
        const now = runOf(qid);
        if (!now) return;
        const { prompt: _prompt, ...rest } = now;
        setRun(qid, { ...rest, status: 'stopped' });
      },
      pick: async (qid: string, question: string, value: string) => store.dispatch({ type: 'question_pick', qid, question, answer: value }),
      answer: async (qid: string, value: ClaudeAnswer) => answer(qid, value),
    },
    stats: { note: async () => undefined },
  };

  const reset = (): void => {
    for (const q of store.getState().questions) store.dispatch({ type: 'question_remove', qid: q.qid });
    store.dispatch({ type: 'question_add', question: chatCard });
    store.dispatch({ type: 'question_add', question: planCard });
  };
  reset();

  let seen: DomainState | undefined;
  let shown: AppState | undefined;
  const view = {
    getState: (): AppState => {
      const now = store.getState();
      if (now !== seen || !shown) {
        seen = now;
        shown = { ...now, view: { kind: 'room' }, tabs: [], away: false, search: { ...now.search, cursor: 0 } } as unknown as AppState;
      }
      return shown;
    },
    subscribe: store.subscribe,
    dispatch: store.dispatch.bind(store),
  };

  return { store: view, api, reset } as unknown as SocketClient;
};
