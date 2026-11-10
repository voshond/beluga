import type { RunRouting, RunSubagent } from '../../agent/types.js';
import type { Effort } from '../../shared/settings-schema.js';
import type { Issue } from './model.js';

export type RouteTier = 'small' | 'medium' | 'large';

export type TaskRoute = {
  readonly size: RouteTier;
  readonly orchestrator: { readonly model: string; readonly effort: Effort };
  readonly builder: RouteTier;
  readonly scout: RouteTier;
  readonly checker: RouteTier;
};

export type RoutedRun = {
  readonly model: string;
  readonly effort: Effort;
  readonly routing: RunRouting;
};

export const TIER_MODEL: Readonly<Record<RouteTier, string>> = { small: 'haiku', medium: 'sonnet', large: 'opus' };

const ROUTES: Readonly<Record<RouteTier, TaskRoute>> = {
  small: { size: 'small', orchestrator: { model: TIER_MODEL.medium, effort: 'medium' }, builder: 'small', scout: 'small', checker: 'small' },
  medium: { size: 'medium', orchestrator: { model: TIER_MODEL.large, effort: 'medium' }, builder: 'medium', scout: 'small', checker: 'small' },
  large: { size: 'large', orchestrator: { model: TIER_MODEL.large, effort: 'high' }, builder: 'medium', scout: 'small', checker: 'medium' },
};

const LARGE_LABELS = ['important'];
const MEDIUM_LABELS = ['feature', 'bug', 'design'];

export const criteriaCount = (acceptance: string | undefined): number => (acceptance ?? '').split('\n').filter((line) => /^\s*[-*]\s*\[[ xX]\]/.test(line)).length;

export const taskSize = (issue: Pick<Issue, 'estimate' | 'labels' | 'brief'>): RouteTier => {
  const estimate = issue.estimate ?? 0;
  const criteria = criteriaCount(issue.brief.acceptance);
  const labelled = (names: readonly string[]): boolean => issue.labels.some((label) => names.includes(label));
  if (estimate >= 5 || criteria >= 6 || labelled(LARGE_LABELS)) return 'large';
  if (estimate >= 2 || criteria >= 3 || labelled(MEDIUM_LABELS)) return 'medium';
  return 'small';
};

export const routeTask = (issue: Pick<Issue, 'estimate' | 'labels' | 'brief'>): TaskRoute => ROUTES[taskSize(issue)];

const WORKER_RULES = ['Never commit, push, change the task board or ask the user anything: the orchestrator does those.', 'Never widen your step: work you find outside it goes in your report, not in the code.'].join('\n');

const REPORT_SHAPE = 'End with a short report: its first line one of `done`, `blocked` or `failed`; then what you changed (files), what you ran and how it went, and anything the orchestrator must decide.';

const workerAgents = (route: TaskRoute): Readonly<Record<string, RunSubagent>> => ({
  'beluga-scout': {
    description: 'Finds things in the code for the orchestrator: where something lives, how it works today, which tests cover it. Read-only and cheap: use it before reading widely yourself.',
    prompt: ['You are a scout on a Beluga task. Find what the orchestrator asked and report it; never change a file.', 'Answer with paths and line numbers, the few lines that matter, and what you looked for and did not find.', WORKER_RULES].join('\n'),
    model: TIER_MODEL[route.scout],
    effort: 'low',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'mcp__beluga_board'],
  },
  'beluga-builder': {
    description: 'Does one well-specified step of the task: the change, where, and when it is done. Give it everything it needs; it does not see this conversation.',
    prompt: [
      'You are a builder on a Beluga task: the orchestrator routed one step to you. Do exactly that step, in the files it names, following the decisions it passed on.',
      'Match the code around you. Run the checks it names (typecheck and the test files you touched), never the full suites.',
      WORKER_RULES,
      REPORT_SHAPE,
    ].join('\n'),
    model: TIER_MODEL[route.builder],
    effort: 'medium',
    disallowedTools: ['mcp__beluga_board'],
  },
  'beluga-checker': {
    description: 'Checks finished work before the orchestrator signs it off: runs the checks it names and reads the diff against the acceptance criteria. Verifies, never fixes.',
    prompt: [
      'You are a checker on a Beluga task. Run the checks the orchestrator names and read the diff (git diff against the branch start) against each acceptance criterion it gives you.',
      'Never fix anything. Report each criterion as pass or fail with its evidence (a command and its result, a file and line), then every failing check with its output.',
      WORKER_RULES,
    ].join('\n'),
    model: TIER_MODEL[route.checker],
    effort: 'low',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'mcp__beluga_board'],
  },
});

export const routingBrief = (route: TaskRoute): string =>
  [
    `Routed run (Settings › Experimental › Routed task runs): this task was sized ${route.size}, so you run on ${route.orchestrator.model} as its orchestrator, and smaller models do the legwork as subagents. You decide, route and review.`,
    `1. Understand: read the brief, then send beluga-scout (${TIER_MODEL[route.scout]}) to find what you need (files, how it works today, the tests that cover it) instead of reading widely yourself. Read yourself only what you must judge.`,
    '2. Plan: cut the work into steps a person could review one by one, and keep them as your todo list.',
    `3. Route each step: beluga-builder (${TIER_MODEL[route.builder]}) for a step with a clear spec; do a step yourself when it needs judgment (an interface, a design decision, a subtle bug, a change across many files that must stay consistent) or after a builder failed it twice. Steps that touch different files may run side by side.`,
    '4. Brief a builder fully: it does not see this conversation. Name the files, the decisions already made, the acceptance criteria the step serves and the checks to run. Never pass on a vague step, and never resend a blocked or failed one unchanged: change the brief or do it yourself.',
    `5. Verify: when the steps are done, send beluga-checker (${TIER_MODEL[route.checker]}) with the acceptance criteria and the checks to run, then read the diff yourself. You sign it off: tick the criteria, write the handoff, commit.`,
    'Questions only the user can answer, the task board and commits stay yours; workers never ask the user. Work found outside the task becomes a sub-task, not a builder step. A one-line fix needs no routing: just do it.',
  ].join('\n');

export const routedRun = (route: TaskRoute): RoutedRun => ({
  model: route.orchestrator.model,
  effort: route.orchestrator.effort,
  routing: { brief: routingBrief(route), agents: workerAgents(route) },
});
