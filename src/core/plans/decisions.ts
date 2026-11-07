import type { ClaudeAnswer, ClaudeQuestion } from '../../protocol.js';
import type { Actor, BoardState, Issue } from '../board/model.js';
import type { Store } from '../store.js';
import { type Plan, type PlanAsk, type PlanRun, planTitle } from './model.js';
import { FINISHED, type PlanView, type TaskState, type TaskView, planView } from './progress.js';

/**
 * A plan task that's yours (assignee "me": accounts, secrets, decisions) never gets a worktree.
 * When it's ready, Beluga asks you in the plan's conversation instead: a card with the question,
 * its options (pick one, or several) and room for your own words, which also raises the on-screen
 * pop-up. Your answer is written on the task (its Decisions and a comment), the task is done, and
 * what waited on it goes on; the head Claude hears what you decided.
 */

const PREFIX = 'decide:';
/** A question a task's Claude asked (plan_ask, BLG-6): asked the same way, the task isn't yours. */
const ASK = 'ask:';

/** The card's id for one plan task (stable, so it's asked once and found again after a restart). */
export const decisionQid = (planId: string, taskId: string): string => `${PREFIX}${planId}:${taskId}`;

/** The card's id for a question a task's Claude asked about it (one per task; asked at `at`, so a new one is a new card). */
export const askQid = (planId: string, taskId: string, at: number): string => `${ASK}${planId}:${taskId}:${at}`;

/** The plan and task a decision card is about (undefined: it's not a decision); `ask`: a task's Claude asked it. */
export function parseDecisionQid(qid: string): { readonly plan: string; readonly task: string; readonly ask?: true } | undefined {
  const ask = qid.startsWith(ASK);
  if (!ask && !qid.startsWith(PREFIX)) return undefined;
  const rest = qid.slice((ask ? ASK : PREFIX).length);
  const at = rest.indexOf(':');
  if (at <= 0 || at >= rest.length - 1) return undefined;
  const plan = rest.slice(0, at);
  const task = ask ? rest.slice(at + 1).replace(/:\d+$/, '') : rest.slice(at + 1);
  return task ? { plan, task, ...(ask ? { ask: true as const } : {}) } : undefined;
}

export const isDecisionQid = (qid: string): boolean => parseDecisionQid(qid) !== undefined;

/** Not yours to answer yet: its milestone hasn't opened, or it waits on other tasks. */
const NOT_YET: ReadonlySet<TaskState> = new Set(['draft', 'later', 'blocked']);

/**
 * The plan's tasks that wait on your decision right now: yours, on the board, in an open milestone,
 * nothing left to wait on, never started in a worktree, not finished. None while the plan is paused.
 */
export function awaitingYou(view: PlanView): readonly TaskView[] {
  const { plan } = view;
  if (plan.status !== 'active' || !plan.body || plan.paused) return [];
  const open = new Set(view.open.map((m) => m.milestone.id));
  return view.milestones.flatMap((m) => m.tasks).filter((t) => t.forYou && t.issue && open.has(t.milestoneId) && !t.worktree && !t.issue.worktrees.length && !FINISHED.has(t.state) && !NOT_YET.has(t.state));
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A card's question holds 1000 characters (the protocol's cap); the commands keep up to this many of them. */
const MAX_QUESTION = 1000;
const MAX_RUN_TEXT = 760;

const shellWord = (text: string): string => (/^[\w@%+=:,./~-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);

/** What you run, as the card shows it: the machine, the commands in a block to copy (its folder is the cd that starts it), and how you tell it worked. */
export function runMarkdown(run: PlanRun): string {
  const commands = [...(run.cwd ? [`cd ${shellWord(run.cwd)}`] : []), ...run.commands];
  return [`Run${run.on ? ` on **${run.on}**` : ''}:`, '```sh', ...commands, '```', run.expect ? `It worked when: ${run.expect}` : ''].filter(Boolean).join('\n');
}

/** The question with its commands under it: the words are cut to fit, the commands first of all. */
function withRun(what: string, run: PlanRun | undefined): string {
  if (!run) return clip(what, MAX_QUESTION);
  const commands = clip(runMarkdown(run), MAX_RUN_TEXT);
  return `${clip(what, MAX_QUESTION - commands.length - 2)}\n\n${commands}`;
}

/** When the plan said nothing to choose from: it's done, or it isn't needed (your own words always fit too). */
function fallbackOptions(t: TaskView): Array<{ label: string; description: string }> {
  const done = t.task.acceptance.length ? `Done: ${t.task.acceptance.join('; ')}` : 'Done: the plan carries on';
  const run = t.task.decision?.run;
  if (run) return [
    { label: 'Done', description: clip(run.expect ? `It worked: ${run.expect}` : done, 600) },
    { label: 'It failed', description: 'Write what it printed (the last lines) instead' },
  ];
  return [
    { label: 'Done', description: clip(done, 600) },
    { label: 'Not needed', description: 'Skip it: the plan carries on without it' },
  ];
}

/** The card a task of yours gets: the plan's question for it (or what the task is), and its options. */
export function decisionQuestion(t: TaskView): Extract<ClaudeQuestion, { kind: 'question' }> {
  const d = t.task.decision;
  const what = [`**${t.task.title}**`, t.task.goal ?? '', d?.question ?? (t.task.acceptance.length ? `Done when: ${t.task.acceptance.join('; ')}` : '')].filter(Boolean).join('\n\n');
  const options = d?.options.length ? d.options.map((o) => ({ label: clip(o.label, 200), description: clip(o.description ?? '', 600) })) : fallbackOptions(t);
  return {
    kind: 'question',
    questions: [{ question: withRun(what, d?.run), header: clip(t.issue?.key ? `${t.issue.key} · Your call` : 'Your call', 40), options: options.slice(0, 6), multiSelect: Boolean(d?.multi && d.options.length) }],
  };
}

/** What you answered, in words: the option(s) you picked, or what you wrote. */
export function answerText(answer: ClaudeAnswer): string | undefined {
  if (answer.kind !== 'answers') return undefined;
  const text = Object.values(answer.answers)
    .map((v) => v.trim())
    .filter((v) => v && v !== '(none)')
    .join('; ');
  return text || undefined;
}

/** The label a recommended option shows with (the way Claude marks one), taken off again in the answer. */
const RECOMMENDED = ' (Recommended)';

/** The card for a question a task's Claude asked: what it's about, why it matters, its options (the recommended one first). */
export function askQuestion(ask: PlanAsk, key: string, title: string): Extract<ClaudeQuestion, { kind: 'question' }> {
  const what = [`**${key} “${title}”**: its agent asks`, ask.question, ask.why ?? ''].filter(Boolean).join('\n\n');
  const rec = ask.options.find((o) => o.label === ask.recommended);
  const options = [...(rec ? [rec] : []), ...ask.options.filter((o) => o !== rec)].map((o) => ({ label: clip(o === rec ? `${o.label}${RECOMMENDED}` : o.label, 200), description: clip(o.description ?? '', 600) }));
  return { kind: 'question', questions: [{ question: withRun(what, ask.run), header: clip(`${key} · Agent asks`, 40), options: options.slice(0, 6), multiSelect: Boolean(ask.multi) }] };
}

/** The questions tasks' Claudes asked that still wait (their task on the board and not finished), by plan. */
export function asksDue(plans: readonly Plan[], board: BoardState): Array<{ readonly qid: string; readonly plan: Plan; readonly ask: PlanAsk; readonly issue: Issue; readonly title: string }> {
  return plans.flatMap((plan) => {
    if (plan.status !== 'active' || !plan.body || !plan.asks) return [];
    return Object.values(plan.asks).flatMap((ask) => {
      const task = plan.body!.milestones.flatMap((m) => m.tasks).find((t) => t.id === ask.task);
      const issue = task?.issueId ? board.issues.find((i) => i.id === task.issueId) : undefined;
      return task && issue && !ASK_OVER.has(issue.status) ? [{ qid: askQid(plan.id, ask.task, ask.at), plan, ask, issue, title: task.title }] : [];
    });
  });
}

/** A question about a task that got this far isn't waiting any more (the work went on without it). */
const ASK_OVER: ReadonlySet<Issue['status']> = new Set(['in_plan', 'done', 'canceled']);

/** The questions a card can ask about, by plan: every task of every running plan waiting on you. */
export function decisionsDue(plans: readonly Plan[], board: BoardState): Array<{ readonly qid: string; readonly plan: Plan; readonly task: TaskView }> {
  return plans.flatMap((plan) => (plan.status === 'active' && plan.body ? awaitingYou(planView(plan, board)).map((task) => ({ qid: decisionQid(plan.id, task.task.id), plan, task })) : []));
}

export interface PlanDecisionsDeps {
  readonly store: Store;
  readonly plans: { readonly list: () => readonly Plan[]; readonly get: (id: string) => Plan | undefined; note(id: string, kind: 'finished' | 'note', text: string, by: Actor): unknown; setAsk(id: string, task: string, ask: undefined): unknown };
  readonly board: {
    readonly me: () => Actor;
    readonly board: {
      get(ref: string): Issue | undefined;
      editBrief(ref: string, section: 'decisions', text: string, by: Actor, opts: { readonly reason?: string; readonly mode?: 'append' }): unknown;
      comment(ref: string, text: string, by: Actor): unknown;
      update(ref: string, patch: { readonly status: 'done' }, by: Actor): unknown;
    };
  };
  readonly questions: { pose(qid: string, channel: string, question: ClaudeQuestion, onAnswer: (a: ClaudeAnswer) => void): void; withdraw(qid: string): void };
  /** Tell the plan's head Claude (queued behind what it's doing; not echoed as yours). */
  readonly askClaude: (prompt: string, channel: string) => void;
  /** Move the plan along now (what waited on the task can start). */
  readonly schedule: () => void;
}

/** Keeps a decision card up for every plan task that waits on you, and carries out your answer. */
export class PlanDecisions {
  private readonly asked = new Set<string>();
  private readonly told = new Set<string>();
  private seen: { plans: unknown; board: unknown } = { plans: undefined, board: undefined };
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: PlanDecisionsDeps) {
    this.unsubscribe = deps.store.subscribe(() => this.sync());
    this.sync();
  }

  stop(): void {
    this.unsubscribe();
    for (const qid of this.asked) this.deps.questions.withdraw(qid);
    this.asked.clear();
  }

  /** Ask what's due, take back what isn't any more. `force`: look again even if nothing changed (the pilot's forYou hook). */
  sync(force = false): void {
    const state = this.deps.store.getState();
    if (!force && this.seen.plans === state.plans && this.seen.board === state.board) return;
    this.seen = { plans: state.plans, board: state.board };
    const due = decisionsDue(this.deps.plans.list(), state.board);
    const asks = asksDue(this.deps.plans.list(), state.board);
    this.dropStaleAsks(asks);
    const want = new Set([...due.map((d) => d.qid), ...asks.map((a) => a.qid)]);
    for (const qid of [...this.asked]) {
      if (want.has(qid)) continue;
      this.asked.delete(qid);
      this.deps.questions.withdraw(qid);
    }
    for (const d of due) {
      if (this.asked.has(d.qid)) continue;
      this.asked.add(d.qid);
      const { plan, task } = d;
      this.deps.questions.pose(d.qid, plan.home, decisionQuestion(task), (answer) => this.decided(plan.id, task.task.id, d.qid, answer));
      if (!this.told.has(d.qid)) {
        this.told.add(d.qid);
        this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `${task.issue?.key ?? task.task.id} “${task.task.title}” is yours: no worktree for it. Answer it here, and the plan carries on.`, level: 'info' });
      }
    }
    for (const a of asks) {
      if (this.asked.has(a.qid)) continue;
      this.asked.add(a.qid);
      this.deps.questions.pose(a.qid, a.plan.home, askQuestion(a.ask, a.issue.key, a.title), (answer) => this.answered(a.plan.id, a.ask, a.qid, answer));
    }
  }

  /** Questions on the plan whose task finished, or went (the work went on without them): taken off it. */
  private dropStaleAsks(live: ReadonlyArray<{ readonly plan: Plan; readonly ask: PlanAsk }>): void {
    const keep = new Set(live.map((a) => `${a.plan.id}:${a.ask.task}`));
    for (const plan of this.deps.plans.list()) for (const task of Object.keys(plan.asks ?? {})) if (plan.status === 'active' && !keep.has(`${plan.id}:${task}`)) this.deps.plans.setAsk(plan.id, task, undefined);
  }

  /** Your answer to a task's Claude: on the task's Decisions, off the plan, and sent back to the Claude that asked. */
  private answered(planId: string, ask: PlanAsk, qid: string, answer: ClaudeAnswer): void {
    this.asked.delete(qid);
    const plan = this.deps.plans.get(planId);
    const task = plan?.body?.milestones.flatMap((m) => m.tasks).find((t) => t.id === ask.task);
    const issue = task?.issueId ? this.deps.board.board.get(task.issueId) : undefined;
    const text = answerText(answer)?.split(RECOMMENDED).join('');
    if (!plan || !task || !issue) return;
    if (!text) {
      this.seen = { plans: undefined, board: undefined };
      this.sync();
      return;
    }
    const me = this.deps.board.me();
    try {
      this.deps.board.board.editBrief(issue.id, 'decisions', `- ${ask.question} → ${text} (the user, asked by its agent)`, me, { mode: 'append', reason: 'answered in the plan’s conversation' });
      this.deps.board.board.comment(issue.id, `Answered: ${text}`, me);
      this.deps.plans.note(planId, 'note', `${issue.key}: the user answered “${text}”`, me);
    } catch (err) {
      this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `Couldn’t record your answer on ${issue.key}: ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
      return;
    }
    if (this.deps.plans.get(planId)?.asks?.[ask.task]?.at === ask.at) this.deps.plans.setAsk(planId, ask.task, undefined);
    this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `You answered ${issue.key}: ${text}. Its agent has it.`, level: 'info' });
    this.deps.askClaude(
      [
        `The user answered your question on ${issue.key} “${task.title}”:`,
        '',
        `> ${ask.question}`,
        '',
        text,
        '',
        'It’s recorded in the task’s Decisions. Go on with the work it was holding up, the same way as before.',
      ].join('\n'),
      `ws:${ask.worktree}`,
    );
    this.deps.schedule();
  }

  /** Your answer: on the task, the task done, the plan moving on, and the head Claude told. */
  private decided(planId: string, taskId: string, qid: string, answer: ClaudeAnswer): void {
    this.asked.delete(qid);
    const plan = this.deps.plans.get(planId);
    const task = plan?.body?.milestones.flatMap((m) => m.tasks).find((t) => t.id === taskId);
    const issue = task?.issueId ? this.deps.board.board.get(task.issueId) : undefined;
    const text = answerText(answer);
    if (!plan || !task || !issue) return;
    if (!text) {
      // Nothing picked (an empty multi-select): it's asked again.
      this.seen = { plans: undefined, board: undefined };
      this.sync();
      return;
    }
    const me = this.deps.board.me();
    try {
      this.deps.board.board.editBrief(issue.id, 'decisions', `- ${text}`, me, { mode: 'append', reason: 'decided in the plan’s conversation' });
      this.deps.board.board.comment(issue.id, `Decided: ${text}`, me);
      this.deps.board.board.update(issue.id, { status: 'done' }, me);
      this.deps.plans.note(planId, 'finished', `${issue.key} decided: ${text}`, me);
    } catch (err) {
      this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `Couldn’t record your answer on ${issue.key}: ${err instanceof Error ? err.message : String(err)}`, level: 'error' });
      return;
    }
    this.deps.store.dispatch({ type: 'system', channel: plan.home, text: `You decided ${issue.key} “${task.title}”: ${text}. It’s done, and what waited on it goes on.`, level: 'info' });
    this.deps.askClaude(
      [
        `The user decided ${issue.key} “${task.title}” (a task of theirs in the plan “${planTitle(plan)}”): ${text}`,
        '',
        'It’s marked done and what waited on it starts by itself. If the answer changes the plan, change it with plan_update, and tell running tasks it affects with plan_message_task. Otherwise answer with one short line.',
      ].join('\n'),
      plan.home,
    );
    this.deps.schedule();
  }
}
