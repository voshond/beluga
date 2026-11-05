import { tool, toolSuite } from './tool-kit.js';
import { z } from 'zod';
import { DEFAULT_LABELS } from '../core/board/labels.js';
import type { BodyInput, MilestoneInput, PlanOp, TaskInput } from '../core/plans/edit.js';
import type { PlanTools } from './types.js';

/**
 * A plan as Claude's tools (server `beluga_plan`), in the plan's home conversation: write the plan
 * and change it (a draft the user approves), see where it stands, check a milestone, start a ready
 * task, and talk to a task's Claude. Starting and passing go through Beluga's scheduler.
 */

export const PLAN_TOOL_NAMES = ['plan_get', 'plan_write', 'plan_update', 'plan_gate', 'plan_start_task', 'plan_message_task', 'plan_stop_task', 'plan_pause', 'plan_ask', 'plan_handback'].map((n) => `mcp__beluga_plan__${n}`);

/** A milestone's Claude's tools (BLG-6, BLG-7): only it has them, and it has only them. */
const WORKER_TOOLS: readonly string[] = ['plan_ask', 'plan_handback'];

const id = z.string().min(1).max(40).describe('A short stable id, like "auth-api" (letters, digits, dashes)');
const lines = (max: number) => z.array(z.string().min(1).max(400)).max(max);
const PRIORITY = z.enum(['urgent', 'high', 'medium', 'low', 'none']);
const ESTIMATE = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8)]);
const AUTONOMY = z.enum(['step', 'gated', 'autopilot']);

const TASK = z.object({
  id: id.optional(),
  title: z.string().min(1).max(200),
  goal: z.string().max(4000).optional().describe('What it’s for, in your own words'),
  context: z.string().max(8000).optional().describe('What someone new needs: files, how it works today'),
  acceptance: lines(20).optional().describe('Checkable statements: done means all are true'),
  blocked_by: z.array(z.string().max(40)).max(12).optional().describe('Ids of tasks whose code this one builds on (same or earlier milestone)'),
  parent: z.string().max(40).optional().describe('A sub-task’s parent (id, same milestone)'),
  priority: PRIORITY.optional(),
  estimate: ESTIMATE.optional().describe('1 an hour, 2 half a day, 3 a day, 5 a few days, 8 a week (split it)'),
  labels: z.array(z.string().max(32)).max(6).optional().describe(`From the board's set only: ${DEFAULT_LABELS.map((l) => l.name).join(', ')}, and any the project added`),
  touches: z.array(z.string().max(200)).max(20).optional().describe('Files or folders it changes (parallel tasks shouldn’t share them)'),
  assignee: z.enum(['claude', 'me']).optional().describe('claude (default), or me: only the user can do it'),
  decision: z
    .object({
      question: z.string().min(1).max(1000).describe('What the user decides, as a question'),
      options: z.array(z.object({ label: z.string().min(1).max(200), description: z.string().max(600).optional() })).max(6).describe('The choices (the user can always write their own instead)'),
      multi: z.boolean().optional().describe('true: they may pick several'),
    })
    .optional()
    .describe('For a task assigned to me: the decision it asks for. No worktree is made; the user answers in the plan chat, and the answer is recorded on the task'),
  issue: z.string().max(40).optional().describe('An existing board task this is (its key, like BOB-12): adopted into the plan'),
});

const DEPENDS_ON = z
  .array(z.string().max(40))
  .max(12)
  .describe('Ids of earlier milestones this one really builds on: it opens once they pass. Leave out to infer it from tasks’ blocked_by; [] runs it alongside from the start');

const MILESTONE = z.object({
  id: id.optional(),
  title: z.string().min(1).max(200),
  goal: z.string().max(4000).optional(),
  criteria: lines(12).describe('Pass criteria: concrete, checkable'),
  autonomy: AUTONOMY.optional(),
  depends_on: DEPENDS_ON.optional(),
  tasks: z.array(TASK).max(40),
});

type Task = z.infer<typeof TASK>;
type Milestone = z.infer<typeof MILESTONE>;

/** A tool's milestone → the plan's (depends_on → dependsOn, tasks converted). */
export function milestoneInput(m: Partial<Milestone>): MilestoneInput {
  const { depends_on, tasks, ...rest } = m;
  return { ...rest, title: m.title ?? '', ...(depends_on ? { dependsOn: depends_on } : {}), tasks: (tasks ?? []).map((t) => taskInput(t) as TaskInput) } as MilestoneInput;
}

/** A tool's task → the plan's (blocked_by → blockedBy; the board key stays for the plan to find). */
export function taskInput(t: Partial<Task>): Partial<TaskInput> & { readonly issue?: string } {
  return {
    ...(t.id ? { id: t.id } : {}),
    ...(t.title ? { title: t.title } : {}),
    ...(t.goal !== undefined ? { goal: t.goal } : {}),
    ...(t.context !== undefined ? { context: t.context } : {}),
    ...(t.acceptance ? { acceptance: t.acceptance } : {}),
    ...(t.blocked_by ? { blockedBy: t.blocked_by } : {}),
    ...(t.parent !== undefined ? { parent: t.parent || null } : {}),
    ...(t.priority ? { priority: t.priority } : {}),
    ...(t.estimate ? { estimate: t.estimate } : {}),
    ...(t.labels ? { labels: t.labels } : {}),
    ...(t.touches ? { touches: t.touches } : {}),
    ...(t.assignee ? { assignee: t.assignee } : {}),
    ...(t.decision ? { decision: { question: t.decision.question, options: t.decision.options, ...(t.decision.multi ? { multi: true } : {}) } } : {}),
    ...(t.issue ? { issue: t.issue } : {}),
  };
}

const OP = z.discriminatedUnion('op', [
  z.object({ op: z.literal('retitle'), title: z.string().max(200).optional(), goal: z.string().max(4000).optional() }),
  z.object({ op: z.literal('add_milestone'), milestone: MILESTONE.partial({ tasks: true, criteria: true }), after: z.string().max(40).optional() }),
  z.object({ op: z.literal('update_milestone'), id: z.string().max(40), title: z.string().max(200).optional(), goal: z.string().max(4000).optional(), criteria: lines(12).optional(), autonomy: AUTONOMY.optional(), depends_on: DEPENDS_ON.optional() }),
  z.object({ op: z.literal('remove_milestone'), id: z.string().max(40) }),
  z.object({ op: z.literal('add_task'), milestone: z.string().max(40), task: TASK, after: z.string().max(40).optional() }),
  z.object({ op: z.literal('update_task'), id: z.string().max(40), patch: TASK.partial() }),
  z.object({ op: z.literal('remove_task'), id: z.string().max(40) }),
  z.object({ op: z.literal('move_task'), id: z.string().max(40), milestone: z.string().max(40), before: z.string().max(40).optional() }),
  z.object({ op: z.literal('block'), id: z.string().max(40), by: z.string().max(40), on: z.boolean() }),
]);

/** Tool ops → the plan's ops. */
export function toOps(ops: ReadonlyArray<z.infer<typeof OP>>): PlanOp[] {
  return ops.map((o): PlanOp => {
    switch (o.op) {
      case 'add_milestone':
        return { op: 'add_milestone', milestone: { ...milestoneInput(o.milestone), criteria: o.milestone.criteria ?? [] }, ...(o.after ? { after: o.after } : {}) };
      case 'update_milestone': {
        const { depends_on, ...rest } = o;
        return { ...rest, ...(depends_on ? { dependsOn: depends_on } : {}) };
      }
      case 'add_task':
        return { op: 'add_task', milestone: o.milestone, task: taskInput(o.task) as TaskInput, ...(o.after ? { after: o.after } : {}) };
      case 'update_task':
        return { op: 'update_task', id: o.id, patch: taskInput(o.patch) };
      default:
        return o as PlanOp;
    }
  });
}

function guarded(fn: () => string | Promise<string>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return Promise.resolve()
    .then(fn)
    .then(
      (text) => ({ content: [{ type: 'text' as const, text }] }),
      (err: unknown) => ({ content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }),
    );
}

export function createPlanToolDefs(plan: PlanTools) {
  const defs = [
    tool('plan_get', 'The plan: milestones with their pass criteria, tasks with ids, what waits on what, and (once approved) each task’s state: who’s working, in review, done.', {}, () => guarded(() => plan.get())),
    tool(
      'plan_write',
      'Write the whole plan (replaces the draft). Milestones in order, each with pass criteria and its tasks; milestones run side by side unless depends_on (or a task’s blocked_by) ties them to an earlier one. Keep ids you used before. Nothing reaches the board until the user approves.',
      { title: z.string().min(1).max(200), goal: z.string().max(4000), milestones: z.array(MILESTONE).min(1).max(12) },
      (a) => guarded(() => plan.write({ title: a.title, goal: a.goal, milestones: a.milestones.map(milestoneInput) } as BodyInput)),
    ),
    tool(
      'plan_update',
      'Change the plan with ops, applied in order: retitle, add_milestone, update_milestone, remove_milestone, add_task, update_task (patch), remove_task, move_task, block (id waits on by; on false removes it). On an approved plan the changes are proposed for the user to approve (applied at once on autopilot).',
      { ops: z.array(OP).min(1).max(40), reason: z.string().max(200).optional().describe('Why, in a few words (shown in the plan’s history)') },
      (a) => guarded(() => plan.update(toOps(a.ops), a.reason)),
    ),
    tool(
      'plan_gate',
      'Record your check of a milestone whose tasks are finished: pass or fail, with notes saying per criterion what you checked and found.',
      { milestone: z.string().min(1).max(200), verdict: z.enum(['pass', 'fail']), notes: z.string().min(1).max(8000) },
      (a) => guarded(() => plan.gate(a.milestone, a.verdict, a.notes)),
    ),
    tool('plan_start_task', 'Start a ready task now (a worktree with Claude on it). Only when the user asks: Beluga starts ready tasks by itself unless the plan goes step by step.', { task: z.string().min(1).max(40).describe('Its id in the plan, or its board key') }, (a) => guarded(() => plan.start(a.task))),
    tool(
      'plan_message_task',
      'Tell the Claude working on a started task something: a decision, a heads-up about another task, a correction. mode "queue" (default) waits until its current turn ends (it may be behind a 15-minute test run); "steer" reaches it now: a long command or a stuck turn is interrupted, and Beluga delivers it again if it isn’t read within 2 minutes.',
      {
        task: z.string().min(1).max(40),
        text: z.string().min(1).max(8000),
        mode: z.enum(['queue', 'steer']).optional().describe('queue (default): when its turn ends. steer: now, interrupting what it runs: to stop wasted work, or a correction that changes the work'),
      },
      (a) => guarded(() => plan.message(a.task, a.text, a.mode ?? 'queue')),
    ),
    tool(
      'plan_stop_task',
      'Stop the Claude working on a started task now (its current turn, and messages waiting for it). Use it when the user says stop, or a task is going the wrong way; then tell it what to do instead with plan_message_task, or leave it stopped.',
      { task: z.string().min(1).max(40).describe('Its id in the plan, or its board key') },
      (a) => guarded(() => (plan.stop ? plan.stop(a.task) : 'Stopping a task isn’t available here')),
    ),
    tool(
      'plan_pause',
      'Pause the whole plan (nothing new starts; running tasks go on unless you stop them) or resume it. Only when the user asks.',
      { paused: z.boolean().describe('true: pause; false: resume') },
      (a) => guarded(() => (plan.pause ? plan.pause(a.paused) : 'Pausing isn’t available here')),
    ),
    tool(
      'plan_ask',
      'Ask the user a decision only they can make (a product or design choice, an account, a secret, which of two behaviours): one concrete question, 2 to 4 options and the one you recommend. It goes to the plan’s conversation and their phone; carry on with whatever doesn’t depend on it, and end your turn when nothing else is left: the answer comes to you here and is recorded on the task. Not for routine choices you can make yourself: decide those, and say what you assumed.',
      {
        task: z.string().max(40).optional().describe('The task it’s about (its key, or its id in the plan); left out, the one you’re on'),
        question: z.string().min(1).max(1000).describe('One question, about one thing'),
        why: z.string().max(300).optional().describe('One sentence: why it matters, or what changes with the answer'),
        options: z.array(z.object({ label: z.string().min(1).max(120), description: z.string().max(400).optional() })).min(2).max(4).describe('The choices (they can always write their own instead)'),
        recommended: z.string().max(120).optional().describe('The label of the option you recommend'),
        multi: z.boolean().optional().describe('true: they may pick several'),
      },
      (a) => guarded(() => (plan.ask ? plan.ask(a) : 'Asking the user isn’t available here: decide, and say what you assumed in the task’s Decisions')),
    ),
    tool(
      'plan_handback',
      'Hand work you found that is outside your milestone’s tasks back to the plan (a bug elsewhere, a follow-up, something the user asked for that isn’t a task here). Don’t do it yourself and don’t drop it: the plan’s head turns it into a plan change the user approves. Then go on with your own tasks.',
      { what: z.string().min(1).max(2000).describe('The work, in a few sentences: what and where'), why: z.string().min(1).max(500).describe('Why it isn’t yours: which task it would be outside of') },
      (a) => guarded(() => (plan.handback ? plan.handback(a.what, a.why) : 'Handing work back isn’t available here: note it with task_note')),
    ),
  ];
  const shown = plan.only ?? (plan.worker ? WORKER_TOOLS : defs.map((d) => d.name).filter((n) => !WORKER_TOOLS.includes(n)));
  return defs.filter((d) => shown.includes(d.name));
}

export function createPlanTools(plan: PlanTools) {
  return toolSuite({ name: 'beluga_plan', version: '0.1.0', tools: createPlanToolDefs(plan) });
}
