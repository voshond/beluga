import type { RunRouting, RunSubagent } from '../../agent/types.js';
import type { AgentRef } from '../../protocol.js';
import { experimentOn } from '../../shared/experiments.js';
import type { Effort } from '../../shared/settings-schema.js';
import type { Plan } from '../plans/model.js';
import { type BoardState, type Issue, issueForWorkspace } from './model.js';

export type RouteTier = 'small' | 'medium' | 'large';

export type TaskRoute = {
  readonly size: RouteTier;
  readonly orchestrator: { readonly tier: RouteTier; readonly effort: Effort };
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
  small: { size: 'small', orchestrator: { tier: 'medium', effort: 'medium' }, builder: 'small', scout: 'small', checker: 'small' },
  medium: { size: 'medium', orchestrator: { tier: 'large', effort: 'medium' }, builder: 'medium', scout: 'small', checker: 'small' },
  large: { size: 'large', orchestrator: { tier: 'large', effort: 'high' }, builder: 'medium', scout: 'small', checker: 'medium' },
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

export const ROUTED_RUNTIMES = ['claude', 'codex'] as const;
export type RoutedRuntime = (typeof ROUTED_RUNTIMES)[number];

const TIER_WORDS: Readonly<Record<RouteTier, string>> = { small: 'the small, fast model', medium: 'the default model', large: 'the most capable model' };

const SPAWN: Readonly<Record<RoutedRuntime, string>> = {
  claude: 'Hand a step to a worker with the Agent tool, its subagent_type the worker’s name.',
  codex: 'Hand a step to a worker by spawning a sub-agent with agent_type set to the worker’s name, and wait for its report. beluga-scout and beluga-checker are read-only by your word alone: tell them not to edit.',
};

const modelName = (runtime: RoutedRuntime, tier: RouteTier): string => (runtime === 'claude' ? TIER_MODEL[tier] : TIER_WORDS[tier]);

export const routingBrief = (route: TaskRoute, runtime: RoutedRuntime = 'claude'): string =>
  [
    `Routed run (Settings › Experimental › Routed task runs): this task was sized ${route.size}, so you run on ${modelName(runtime, route.orchestrator.tier)} as its orchestrator, and smaller models do the legwork as workers. You decide, route and review. ${SPAWN[runtime]}`,
    `1. Understand: read the brief, then send beluga-scout (${modelName(runtime, route.scout)}) to find what you need (files, how it works today, the tests that cover it) instead of reading widely yourself. Read yourself only what you must judge.`,
    '2. Plan: cut the work into steps a person could review one by one, and keep them as your todo list.',
    `3. Route each step: beluga-builder (${modelName(runtime, route.builder)}) for a step with a clear spec; do a step yourself when it needs judgment (an interface, a design decision, a subtle bug, a change across many files that must stay consistent) or after a builder failed it twice. Steps that touch different files may run side by side.`,
    '4. Brief a builder fully: it does not see this conversation. Name the files, the decisions already made, the acceptance criteria the step serves and the checks to run. Never pass on a vague step, and never resend a blocked or failed one unchanged: change the brief or do it yourself.',
    `5. Verify: when the steps are done, send beluga-checker (${modelName(runtime, route.checker)}) with the acceptance criteria and the checks to run, then read the diff yourself. You sign it off: tick the criteria, write the handoff, commit.`,
    'Questions only the user can answer, the task board and commits stay yours; workers never ask the user. Work found outside the task becomes a sub-task, not a builder step. A one-line fix needs no routing: just do it.',
  ].join('\n');

export const routedRun = (route: TaskRoute, runtime: RoutedRuntime = 'claude'): RoutedRun => ({
  model: TIER_MODEL[route.orchestrator.tier],
  effort: route.orchestrator.effort,
  routing: { brief: routingBrief(route, runtime), agents: workerAgents(route) },
});

export const routableRuntime = (experiments: readonly string[] | undefined, runtime: string): RoutedRuntime | undefined =>
  experimentOn(experiments, 'routing') ? ROUTED_RUNTIMES.find((id) => id === runtime) : undefined;

type RouteState = {
  readonly prefs: { readonly experiments?: readonly string[] };
  readonly board: BoardState;
  readonly plans: { readonly plans: ReadonlyArray<Pick<Plan, 'status' | 'body' | 'movedTo' | 'runs'>> };
  readonly projects: ReadonlyArray<{ readonly workspaces: ReadonlyArray<{ readonly id: string; readonly agent?: AgentRef; readonly model?: string }> }>;
};

export type ConversationRoute = {
  readonly route: TaskRoute;
  readonly runtime: RoutedRuntime;
  readonly picked: boolean;
};

const inMilestone = (st: RouteState, workspaceId: string): boolean =>
  st.plans.plans.some((plan) => plan.status === 'active' && plan.body && !plan.movedTo && Object.values(plan.runs).some((run) => run?.agent?.worktree === workspaceId));

export const conversationRoute = (st: RouteState, channel: string, defaultRuntime: string): ConversationRoute | undefined => {
  if (!channel.startsWith('ws:')) return undefined;
  const id = channel.slice('ws:'.length);
  const ws = st.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
  if (!ws) return undefined;
  const runtime = routableRuntime(st.prefs.experiments, ws.agent?.runtime ?? defaultRuntime);
  const issue = issueForWorkspace(st.board, id);
  if (!runtime || !issue || inMilestone(st, id)) return undefined;
  return { route: routeTask(issue), runtime, picked: Boolean(ws.model || ws.agent?.model) };
};

const TIER_LABEL: Readonly<Record<RoutedRuntime, Readonly<Record<RouteTier, string>>>> = {
  claude: { small: 'Haiku', medium: 'Sonnet', large: 'Opus' },
  codex: { small: 'Fast', medium: 'Default', large: 'Frontier' },
};

export const routeModelLabel = (route: TaskRoute, runtime: RoutedRuntime): string => TIER_LABEL[runtime][route.orchestrator.tier];

export const routeSummary = (route: TaskRoute, runtime: RoutedRuntime): string => {
  const name = (tier: RouteTier): string => TIER_LABEL[runtime][tier];
  return `Sized ${route.size} from its task: ${name(route.orchestrator.tier)} plans and reviews, ${name(route.builder)} builds, ${name(route.scout)} scouts`;
};
