import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../src/agent/types.js';
import { keepLines, trackedSpawn } from '../src/agent/runtime/claude/claude-process.js';
import { AgentHost } from '../src/core/agent-host.js';
import { Board } from '../src/core/board/board.js';
import { BoardWork } from '../src/core/board/work.js';
import type { BodyInput } from '../src/core/plans/edit.js';
import { Plans } from '../src/core/plans/plans.js';
import { liveFrom, planView } from '../src/core/plans/progress.js';
import { LIMIT_MARGIN_MS, pulseWords } from '../src/core/plans/watchdog.js';
import { PlansWork } from '../src/core/plans/work.js';
import { Store, initialState } from '../src/core/store.js';
import { Workbench } from '../src/core/workbench.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import type { BodyOf } from '../src/protocol.js';
import { CONTINUE_PROMPT, CRASH_RETRY_MS, RunFailedError, classifyRun, decodeFailure, encodeFailure, failureText, failureTitle, resetFromText } from '../src/shared/run-failure.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { PLATFORM_DOCS, signInChoices } from '../packages/mac/src/chat/sign-in-choices.js';
import { waitFor } from './helpers.js';

/** Running out of usage or Claude Code crashing: said in words, continued in one click, or by itself. */

const MIN = 60_000;
const at = (h: number, m = 0, base = Date.now()): number => new Date(base).setHours(h, m, 0, 0);

describe('how a run ended, in words', () => {
  it('a rate_limit_event that said no: your usage limit, with its reset time', () => {
    const resetsAt = at(15) + 24 * 60 * MIN;
    const f = classifyRun({ error: 'Claude Code process exited with code 1', rejectedUntil: resetsAt, stderr: [] });
    expect(f).toMatchObject({ kind: 'usage_limit', resetsAt });
    expect(failureTitle({ ...f, resetsAt: at(15) }, at(12))).toBe('You hit your Claude plan usage limit · resets at 15:00');
  });

  it("Claude Code's limit notice: the reset time read from its words", () => {
    const now = at(12);
    expect(classifyRun({ result: "You've hit your limit · resets 3pm (Europe/Istanbul)" }, now)).toMatchObject({ kind: 'usage_limit', resetsAt: at(15, 0, now) });
    expect(resetFromText('Claude AI usage limit reached|1760000000', now)).toBe(1_760_000_000_000);
    expect(resetFromText('5-hour limit reached ∙ resets 9:30pm', now)).toBe(at(21, 30, now));
    // Earlier than now: tomorrow.
    expect(resetFromText('resets at 11:00', now)).toBe(at(11, 0, now) + 24 * 60 * MIN);
  });

  it('a crash: its exit code and the last stderr lines, never a bare "exit code 1"', () => {
    const f = classifyRun({ error: 'Claude Code process exited with code 1', stderr: ['loading', 'TypeError: x is undefined', '    at main (cli.js:1:1)'] });
    expect(f).toMatchObject({ kind: 'crash', exitCode: 1 });
    expect(f.detail).toContain('TypeError: x is undefined');
    expect(failureTitle(f)).toBe('Claude Code stopped unexpectedly (exit 1)');
  });

  it('a crash of the Claude Code we spawn ourselves (KLD-43) keeps its exit code and stderr lines (the SDK reads none)', async () => {
    const lines: string[] = [];
    const pids: number[] = [];
    const tracked = trackedSpawn((p) => void pids.push(p.pid), (chunk) => keepLines(lines, chunk, 40));
    const script = "process.stderr.write('Error: ENOSPC: no space left on device\\n    at write (node:fs:1)\\n'); process.exit(3)";
    const child = tracked.spawn({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env, signal: new AbortController().signal }) as unknown as import('node:child_process').ChildProcess;
    const code = await new Promise<number | null>((resolve) => child.once('close', (c) => resolve(c)));
    expect(pids).toHaveLength(1);
    // The SDK's own words for it, with no stderr tail of its own for a custom spawn.
    const f = classifyRun({ error: `Claude Code process exited with code ${code}`, stderr: lines });
    expect(f).toMatchObject({ kind: 'crash', exitCode: 3 });
    expect(f.detail).toContain('Error: ENOSPC: no space left on device');
    expect(f.detail).toContain('at write (node:fs:1)');
    expect(failureTitle(f)).toBe('Claude Code stopped unexpectedly (exit 3)');
  });

  it('network and API errors, and stopping it yourself', () => {
    expect(classifyRun({ error: 'Claude Code process exited with code 1', stderr: ['Error: read ECONNRESET'] }).kind).toBe('network');
    expect(classifyRun({ result: 'API Error: 529 Overloaded', apiError: 'overloaded' }).kind).toBe('api');
    expect(classifyRun({ error: 'aborted', stopped: true }).kind).toBe('stopped');
  });

  it('Claude Code with no login is signed out (Sign In, not Continue), not an API failure', () => {
    const f = classifyRun({ result: 'Not logged in · Please run /login', apiError: 'authentication_failed' });
    expect(f.kind).toBe('signed_out');
    expect(failureTitle(f)).toBe('Claude Code isn’t signed in on this Mac');
    expect(classifyRun({ error: 'Claude Code process exited with code 1', stderr: ['OAuth token has expired'] }).kind).toBe('signed_out');
    // A bad API key is yours to fix in your variables: signing in wouldn't help.
    expect(classifyRun({ result: 'Invalid API key · Fix external API key', apiError: 'authentication_failed' }).kind).toBe('api');
  });

  it('a sign-in that expired or was revoked is signed out too (BLG-589), and says it expired', () => {
    for (const result of ['Failed to authenticate: Auth session expired and could not be refreshed', 'Failed to authenticate: OAuth session expired and could not be refreshed', 'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.']) {
      const f = classifyRun({ result, apiError: 'authentication_failed' });
      expect(f.kind).toBe('signed_out');
      expect(failureTitle(f)).toBe('Claude Code’s sign-in on this Mac expired');
    }
  });

  it('Sign In offers /login’s three choices: a subscription, a Console account, or a 3rd-party platform’s setup page', () => {
    const picked: string[] = [];
    const opened: string[] = [];
    const rows = signInChoices((how) => picked.push(how), (url) => opened.push(url));
    expect(rows.map((r) => r.label)).toEqual(['Claude account with subscription', 'Anthropic Console account', '3rd-party platform']);
    rows[0]!.onSelect();
    rows[1]!.onSelect();
    expect(picked).toEqual(['claudeai', 'console']);
    expect(rows[2]!.submenu?.map((r) => r.label)).toEqual(['Amazon Bedrock', 'Microsoft Foundry', 'Google Vertex AI']);
    rows[2]!.submenu!.forEach((r) => r.onSelect());
    expect(opened).toEqual(PLATFORM_DOCS.map((p) => p.url));
  });

  it('a Claude or Console account signs in with its own flag of `claude auth login`', async () => {
    const store = new Store(initialState('t', 'ask'));
    const wb = new Workbench({
      store,
      controller: { manager: { list: [], find: () => undefined } } as unknown as WorkspaceController,
      notify: () => undefined,
      toast: () => undefined,
      intend: () => undefined,
      askClaude: () => undefined,
      setPrefs: () => undefined,
      remoteRef: () => undefined,
    });
    const open = vi.spyOn(wb as unknown as { openSession: (...a: unknown[]) => unknown }, 'openSession').mockReturnValue(undefined);
    await wb.signInClaude('shell:1', 'room');
    await wb.signInClaude('shell:1', 'room', 'console');
    expect(open.mock.calls.map((c) => String(c[2]).replace(/^.* auth login/, 'auth login'))).toEqual(['auth login --claudeai', 'auth login --console']);
  });

  it("the card's words carry it: a readable line first, the facts after", () => {
    const f = classifyRun({ error: 'Claude Code process exited with code 1', stderr: ['boom'] });
    const text = new RunFailedError(f).message;
    expect(text).toBe(encodeFailure(f));
    expect(text.split('\n')[0]).toBe('Claude Code stopped unexpectedly (exit 1)');
    expect(failureText(text)).toBe('Claude Code stopped unexpectedly (exit 1)');
    expect(decodeFailure(text)).toEqual(f);
    expect(decodeFailure('Agent stopped: error during execution')).toBeUndefined();
  });
});

describe('Continue resumes the session, with what queued behind it in order', () => {
  it('a failed run holds the queue; Continue goes first, then the queue as it was', async () => {
    const store = new Store(initialState('room', 'auto'));
    const prompts: string[] = [];
    let fail = true;
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const agent: AgentBackend = {
      async run(input) {
        prompts.push(input.prompt);
        if (prompts.length === 1) {
          await held;
          if (fail) throw new RunFailedError(classifyRun({ rejectedUntil: at(15), error: 'Claude Code process exited with code 1' }));
        }
        return 'ok';
      },
    };
    const send = (body: { kind: string } & Record<string, unknown>): boolean => {
      if (body.kind !== 'agent_event') return true;
      const e = body as unknown as BodyOf<'agent_event'>;
      store.dispatch({ type: 'agent_event', owner: 'me', requestId: e.requestId, requester: e.requester, event: e.event, text: e.text, ts: Date.now(), channel: e.channel });
      return true;
    };
    const h = new AgentHost({
      store,
      selfId: () => 'me',
      send: send as never,
      agent: () => agent,
      shares: {} as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
      people: {} as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      toast: () => undefined,
      system: () => undefined,
      approvalTimeoutMs: () => 60_000,
      refreshUsage: async () => undefined,
    });
    let n = 0;
    const ask = (prompt: string, urgent = false): Promise<void> => h.onAgentRequest('me', { kind: 'agent_request', requestId: `r${++n}`, prompt, viaAgent: false, channel: 'room', urgent, plan: false });
    await ask('build it');
    await waitFor(() => prompts.length === 1);
    await ask('then the docs');
    await ask('then the tests');
    release();
    // Failed on the limit: said so, and the queue waits instead of failing the same way.
    await waitFor(() => store.getState().log.some((l) => l.type === 'agent' && l.status === 'error'));
    const card = store.getState().log.find((l) => l.type === 'agent' && l.status === 'error');
    expect(card?.type === 'agent' && decodeFailure(card.text)?.kind).toBe('usage_limit');
    await new Promise((r) => setTimeout(r, 20));
    expect(prompts).toEqual(['build it']);
    // Continue (urgent, as the card sends it): first, then the queue in order.
    fail = false;
    await ask(CONTINUE_PROMPT, true);
    await waitFor(() => prompts.length === 4);
    expect(prompts).toEqual(['build it', CONTINUE_PROMPT, 'then the docs', 'then the tests']);
  });
});

const ws = (id: string, projectId: string, name: string, kind: Workspace['kind'] = 'worktree', extra: Partial<Workspace> = {}): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind, projectRoot: '/tmp/p', branch: `klaud/${name}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const BODY: BodyInput = {
  title: 'Payments',
  goal: 'Take payments',
  milestones: [{ id: 'safe', title: 'Safe payments', criteria: ['works'], tasks: [{ id: 'auth', title: 'Auth on payment routes', acceptance: ['401 without session'] }] }],
};

/** A plan with one started task, a pretend clock, and what Klaud asked Claude. */
async function running() {
  const store = new Store(initialState('room'));
  const project: Project = { id: 'api', name: 'bob-api', root: '/tmp/bob-api', base: 'main', workspaces: [ws('main', 'api', 'bob-api', 'chat', { askOnly: true } as Partial<Workspace>)] };
  store.dispatch({ type: 'projects', projects: [project] });
  let n = 0;
  const add = (w: Workspace): void => store.dispatch({ type: 'projects', projects: store.getState().projects.map((p) => (p.id === w.projectId ? { ...p, workspaces: [...p.workspaces, w] } : p)) });
  const controller = {
    onWorktree: () => () => undefined,
    newWorktree: async (projectId: string, name: string) => {
      const w = ws(`w${++n}`, projectId, name);
      add(w);
      return w;
    },
  } as unknown as WorkspaceController;
  const asked: Array<{ prompt: string; channel: string }> = [];
  const board = new Board({ store, dir: null, projectName: () => 'bob-api' });
  const boardWork = new BoardWork({ store, board, controller, selfId: () => 'p-me', selfName: () => 'Kay', askClaude: (prompt, channel) => void asked.push({ prompt, channel }) });
  const plans = new Plans({ store, dir: null });
  let now = at(12);
  const work = new PlansWork({ store, plans, board: boardWork, controller, git: null, askClaude: (prompt, channel) => void asked.push({ prompt, channel }), intend: () => undefined, alive: () => false, takeOver: async () => [], now: () => now, delayMs: 0 });
  const plan = plans.create({ projectId: 'api', home: 'ws:main', autonomy: 'gated' }, boardWork.myClaude());
  work.forRun('ws:main', 'p-me')!.tools!.write(BODY);
  work.approve(plan.id);
  await tick(5);
  const issue = () => store.getState().board.issues.find((i) => i.title === 'Auth on payment routes')!;
  const channel = `ws:${issue().worktrees.at(-1)}`;
  let seq = 0;
  const event = (requestId: string, kind: 'started' | 'tool' | 'error', text = '', where = channel): void => store.dispatch({ type: 'agent_event', owner: 'p-me', requestId, requester: 'p-me', event: kind, text, ts: now, channel: where });
  const later = async (ms: number): Promise<void> => {
    now += ms;
    work.pilot.tick();
    await tick(2);
  };
  const task = () => planView(plans.need(plan.id), store.getState().board, liveFrom(store.getState())).milestones[0]!.tasks[0]!;
  const wakes = () => asked.filter((a) => a.channel === channel && a.prompt.startsWith('You stopped before handing off'));
  return { store, plans, plan, channel, event, newRun: () => `r${++seq}`, later, task, wakes, asked, now: () => now };
}

describe('a usage limit pauses the plan, and it goes on by itself when usage is back', () => {
  it('limit event → paused with the reset time → the task and the head Claude resume after it', async () => {
    const t = await running();
    const resetsAt = at(15, 0, t.now());
    const limit = encodeFailure(classifyRun({ rejectedUntil: resetsAt, error: 'Claude Code process exited with code 1' }), t.now());
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'tool', 'Edit src/auth.ts');
    t.event(r, 'error', limit);
    // The head Claude stopped on the same limit.
    t.event('h1', 'started', '', 'ws:main');
    t.event('h1', 'error', limit, 'ws:main');
    // Never "working": paused, with when it goes on.
    expect(t.task().pulse).toEqual({ kind: 'paused', until: resetsAt });
    expect(pulseWords(t.task().pulse!, t.now())).toEqual({ label: 'Paused · usage limit', sub: 'Resumes at 15:00', tone: 'warn' });
    await t.later(MIN);
    expect(t.wakes()).toHaveLength(0);
    expect(t.task().watch).toMatchObject({ limitUntil: resetsAt });
    expect(t.task().watch?.line).toContain('paused: usage limit · resumes at 15:00');
    // An hour before the reset: still waiting; nobody asks you.
    await t.later(MIN * 60);
    expect(t.wakes()).toHaveLength(0);
    expect(t.task().watch?.needsYou).toBeUndefined();
    // The reset passed: the head Claude and the task go on, each once.
    await t.later(resetsAt - t.now() + LIMIT_MARGIN_MS);
    expect(t.asked.filter((a) => a.channel === 'ws:main' && a.prompt === CONTINUE_PROMPT)).toHaveLength(1);
    expect(t.wakes()).toHaveLength(1);
    expect(t.wakes()[0]!.prompt).toContain('You hit your Claude plan usage limit');
    await t.later(MIN);
    expect(t.wakes()).toHaveLength(1);
    expect(t.asked.filter((a) => a.prompt === CONTINUE_PROMPT)).toHaveLength(1);
  });
});

describe('continuing on its own turned off (BLG-757): the plan waits for you', () => {
  it('off everywhere: neither the task nor the head Claude goes on after the reset', async () => {
    const t = await running();
    t.store.dispatch({ type: 'prefs', prefs: { autoContinue: false } });
    const resetsAt = at(15, 0, t.now());
    const limit = encodeFailure(classifyRun({ rejectedUntil: resetsAt, error: 'Claude Code process exited with code 1' }), t.now());
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'error', limit);
    t.event('h1', 'started', '', 'ws:main');
    t.event('h1', 'error', limit, 'ws:main');
    await t.later(MIN);
    expect(t.task().watch?.line).toContain('continuing on its own is off');
    // The line follows the switch while it waits.
    t.store.dispatch({ type: 'prefs', prefs: { autoContinue: true } });
    await t.later(MIN);
    expect(t.task().watch?.line).toContain('resumes at 15:00');
    t.store.dispatch({ type: 'prefs', prefs: { autoContinue: false } });
    await t.later(resetsAt - t.now() + LIMIT_MARGIN_MS + MIN);
    expect(t.wakes()).toHaveLength(0);
    expect(t.asked.filter((a) => a.prompt === CONTINUE_PROMPT)).toHaveLength(0);
    expect(t.task().watch?.line).toContain('continuing on its own is off');
    // Off in just the task's chat: the head Claude goes on, the task still waits.
    t.store.dispatch({ type: 'prefs', prefs: { autoContinue: true, autoContinueOff: [t.channel] } });
    await t.later(MIN);
    expect(t.asked.filter((a) => a.channel === 'ws:main' && a.prompt === CONTINUE_PROMPT)).toHaveLength(1);
    expect(t.wakes()).toHaveLength(0);
  });
});

describe('a crash is retried once, then it needs you', () => {
  it('crash → one retry after 30s → a second crash: Needs you, with the reason', async () => {
    const t = await running();
    const crash = encodeFailure(classifyRun({ error: 'Claude Code process exited with code 1', stderr: ['boom'] }));
    const r = t.newRun();
    t.event(r, 'started');
    t.event(r, 'error', crash);
    expect(pulseWords(t.task().pulse!, t.now()).label).toBe('Stopped · Claude Code crashed');
    await t.later(1000);
    expect(t.wakes()).toHaveLength(0);
    await t.later(CRASH_RETRY_MS);
    expect(t.wakes()).toHaveLength(1);
    expect(t.wakes()[0]!.prompt).toContain('Claude Code stopped unexpectedly (exit 1)');
    // The retry runs, and crashes again.
    const r2 = t.newRun();
    t.event(r2, 'started');
    t.event(r2, 'error', crash);
    await t.later(CRASH_RETRY_MS + 1000);
    expect(t.wakes()).toHaveLength(1);
    expect(t.task().state).toBe('stalled');
    expect(t.task().watch).toMatchObject({ needsYou: true, reason: 'Claude Code stopped unexpectedly (exit 1)' });
    expect(pulseWords(t.task().pulse!, t.now()).label).toBe('Needs you');
  });
});
