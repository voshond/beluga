import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { runInstructions } from '../src/agent/run-instructions.js';
import { sdkAgents } from '../src/agent/runtime/claude/runner.js';
import { codexRoleConfig, codexTierModel, roleToml } from '../src/agent/runtime/codex/roles.js';
import type { Model } from '../src/agent/runtime/codex/protocol.js';
import { AgentHost } from '../src/core/agent-host.js';
import { conversationRoute, criteriaCount, routeModelLabel, routeSummary, routeTask, routedRun, taskSize } from '../src/core/board/routing.js';
import { NO_BOARD, type Issue } from '../src/core/board/model.js';
import type { Plan } from '../src/core/plans/model.js';
import { Store, initialState } from '../src/core/store.js';
import { waitFor } from './helpers.js';

const task = (over: { estimate?: number; labels?: string[]; acceptance?: string } = {}) => ({
  ...(over.estimate ? { estimate: over.estimate } : {}),
  labels: over.labels ?? [],
  brief: over.acceptance ? { acceptance: over.acceptance } : {},
});

const checklist = (n: number): string => Array.from({ length: n }, (_, i) => `- [ ] criterion ${i}`).join('\n');

describe('sizing a task', () => {
  it('counts checklist lines, ticked or not', () => {
    expect(criteriaCount('- [ ] a\n- [x] b\n* [X] c\nnot one')).toBe(3);
    expect(criteriaCount(undefined)).toBe(0);
  });

  it('a bare chore is small, a feature medium, a big or important one large', () => {
    expect(taskSize(task({ labels: ['chore'] }))).toBe('small');
    expect(taskSize(task({ labels: ['feature'] }))).toBe('medium');
    expect(taskSize(task({ estimate: 2 }))).toBe('medium');
    expect(taskSize(task({ acceptance: checklist(3) }))).toBe('medium');
    expect(taskSize(task({ estimate: 5 }))).toBe('large');
    expect(taskSize(task({ acceptance: checklist(6) }))).toBe('large');
    expect(taskSize(task({ labels: ['important'] }))).toBe('large');
  });

  it('the orchestrator sits a tier above the builder, the scout is always the smallest', () => {
    expect(routeTask(task())).toMatchObject({ orchestrator: { tier: 'medium' }, builder: 'small', scout: 'small' });
    expect(routeTask(task({ estimate: 3 }))).toMatchObject({ orchestrator: { tier: 'large', effort: 'medium' }, builder: 'medium', scout: 'small' });
    expect(routeTask(task({ estimate: 8 }))).toMatchObject({ orchestrator: { tier: 'large', effort: 'high' }, builder: 'medium', checker: 'medium' });
  });
});

describe('a routed run', () => {
  const run = routedRun(routeTask(task({ estimate: 3 })));

  it('gets three workers on smaller models, with the board and edits kept from the read-only ones', () => {
    expect(Object.keys(run.routing.agents)).toEqual(['beluga-scout', 'beluga-builder', 'beluga-checker']);
    expect(run.routing.agents['beluga-scout']).toMatchObject({ model: 'haiku', disallowedTools: expect.arrayContaining(['Edit', 'Write', 'mcp__beluga_board']) });
    expect(run.routing.agents['beluga-builder']).toMatchObject({ model: 'sonnet', disallowedTools: ['mcp__beluga_board'] });
    expect(run.routing.agents['beluga-checker']?.disallowedTools).toContain('Edit');
  });

  it('is told which model does what, and that the board and the user stay its own', () => {
    expect(run.routing.brief).toContain('you run on opus as its orchestrator');
    expect(run.routing.brief).toContain('beluga-builder (sonnet)');
    expect(run.routing.brief).toContain('workers never ask the user');
  });

  it('hands Claude Code its workers as SDK agents', () => {
    const agents = sdkAgents(run.routing);
    expect(agents['beluga-builder']).toMatchObject({ model: 'sonnet', effort: 'medium', disallowedTools: ['mcp__beluga_board'] });
    expect(agents['beluga-scout']?.prompt).toContain('never change a file');
  });
});

const ME = 'me';
const FRIEND = 'friend';
const TREE = 'ws:tree';

function setup(opts: { readonly experiments?: readonly string[]; readonly picked?: string; readonly runtime?: string } = {}) {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'prefs', prefs: { experiments: [...(opts.experiments ?? [])], model: 'claude-default-pick' } });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-routing-'));
  const runs: AgentRunInput[] = [];
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      runs.push(input);
      return 'ok';
    },
  };
  const place = () => ({ cwd: dir, additionalDirectories: [], autoEdit: true, onSession: () => undefined, ...(opts.picked ? { model: opts.picked } : {}) });
  const host = new AgentHost({
    store,
    selfId: () => ME,
    send: () => true,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: { get: () => undefined, list: () => [] } as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    workspaces: { place, refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
    board: (channel, from) => (from === ME ? { tools: { channel } as never, brief: 'the task', route: routeTask(task({ estimate: 3 })) } : undefined),
    ...(opts.runtime ? { agentRef: () => ({ runtime: opts.runtime!, label: opts.runtime! }) } : {}),
  });
  const ask = async (from = ME): Promise<AgentRunInput> => {
    const before = runs.length;
    await host.onAgentRequest(from, { kind: 'agent_request', requestId: `${TREE}-${from}-${before}`, prompt: 'do the task', viaAgent: false, channel: TREE, urgent: false, plan: false });
    await waitFor(() => runs.length > before);
    return runs.at(-1)!;
  };
  return { ask };
}

describe('a task run through the shared workflow', () => {
  it('with Routed task runs off, runs as before on your model', async () => {
    const run = await setup().ask();
    expect(run.routing).toBeUndefined();
    expect(run.model).toBe('claude-default-pick');
  });

  it('with it on, runs as the orchestrator on the routed model with its workers and brief', async () => {
    const run = await setup({ experiments: ['routing'] }).ask();
    expect(run.model).toBe('opus');
    expect(run.effort).toBe('medium');
    expect(Object.keys(run.routing?.agents ?? {})).toContain('beluga-builder');
    expect(runInstructions(run, 'Kay')).toContain('Routed run');
  });

  it('a model picked for the conversation wins', async () => {
    const run = await setup({ experiments: ['routing'], picked: 'haiku' }).ask();
    expect(run.routing).toBeUndefined();
    expect(run.model).toBe('haiku');
  });
});

const model = (id: string, description: string, over: Partial<Model> = {}): Model => ({ id, model: id, displayName: id, description, hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], ...over });

const CODEX_MODELS: readonly Model[] = [
  model('gpt-6.1-sol', 'Latest workhorse model for coding and everyday work.', { isDefault: true }),
  model('gpt-6-astra', 'Frontier intelligence for the most demanding work.'),
  model('gpt-6-luna', 'Fast and affordable model for easier tasks.'),
  model('gpt-reserve', 'Fast and affordable agentic coding model.', { hidden: true }),
];

describe('routing on Codex', () => {
  it('maps the tiers onto Codex’s own models: fast, default, frontier', () => {
    expect(codexTierModel('haiku', CODEX_MODELS)).toBe('gpt-6-luna');
    expect(codexTierModel('sonnet', CODEX_MODELS)).toBe('gpt-6.1-sol');
    expect(codexTierModel('opus', CODEX_MODELS)).toBe('gpt-6-astra');
    expect(codexTierModel('opus', [CODEX_MODELS[0]!])).toBe('gpt-6.1-sol');
    expect(codexTierModel('gpt-x', CODEX_MODELS)).toBeUndefined();
  });

  it('writes each worker as a Codex agent role with its model, effort and instructions', async () => {
    const routing = routedRun(routeTask(task({ estimate: 3 })), 'codex').routing;
    expect(roleToml(routing.agents['beluga-scout']!, CODEX_MODELS)).toBe(`model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\ndeveloper_instructions = ${JSON.stringify(routing.agents['beluga-scout']!.prompt)}\n`);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-codex-roles-'));
    const config = await codexRoleConfig(routing, CODEX_MODELS, dir);
    expect(Object.keys(config)).toEqual(['agents.beluga-scout', 'agents.beluga-builder', 'agents.beluga-checker']);
    expect(readFileSync(config['agents.beluga-builder']!.config_file, 'utf8')).toContain('model = "gpt-6.1-sol"');
  });

  it('tells Codex how to spawn its workers, in model words rather than Claude’s names', () => {
    const brief = routedRun(routeTask(task({ estimate: 3 })), 'codex').routing.brief;
    expect(brief).toContain('agent_type');
    expect(brief).toContain('you run on the most capable model');
    expect(brief).not.toContain('opus');
  });

  it('a Codex task run is routed, another runtime is not', async () => {
    const codex = await setup({ experiments: ['routing'], runtime: 'codex' }).ask();
    expect(codex.routing?.brief).toContain('agent_type');
    const copilot = await setup({ experiments: ['routing'], runtime: 'copilot' }).ask();
    expect(copilot.routing).toBeUndefined();
  });
});

describe('what the screens show for a routed conversation', () => {
  const issue = { id: 'i1', worktrees: ['w1'], estimate: 3, labels: [], brief: {} } as unknown as Issue;
  const routeState = (o: { experiments?: string[]; model?: string; runtime?: string; milestone?: boolean } = {}) => ({
    prefs: { experiments: o.experiments ?? ['routing'] },
    board: { ...NO_BOARD, issues: [issue] },
    plans: { plans: o.milestone ? [{ status: 'active', body: {}, runs: { m1: { agent: { worktree: 'w1' } } } } as unknown as Plan] : [] },
    projects: [{ workspaces: [{ id: 'w1', ...(o.model ? { model: o.model } : {}), ...(o.runtime ? { agent: { runtime: o.runtime, label: o.runtime } } : {}) }, { id: 'w2', kind: 'chat', askOnly: true }, { id: 'w3', kind: 'worktree' }] }],
  });

  it('a worktree doing a task, with the experiment on, is routed the way the daemon routes it', () => {
    expect(conversationRoute(routeState(), 'ws:w1', 'claude')).toMatchObject({ runtime: 'claude', picked: false, route: { size: 'medium' } });
    expect(conversationRoute(routeState({ model: 'haiku' }), 'ws:w1', 'claude')?.picked).toBe(true);
    expect(conversationRoute(routeState({ runtime: 'codex' }), 'ws:w1', 'claude')?.runtime).toBe('codex');
  });

  it('not with the experiment off, without a task, in a plan milestone’s worktree, or on another runtime', () => {
    expect(conversationRoute(routeState({ experiments: [] }), 'ws:w1', 'claude')).toBeUndefined();
    expect(conversationRoute(routeState(), 'ws:w2', 'claude')).toBeUndefined();
    expect(conversationRoute(routeState({ milestone: true }), 'ws:w1', 'claude')).toBeUndefined();
    expect(conversationRoute(routeState({ runtime: 'copilot' }), 'ws:w1', 'claude')).toBeUndefined();
    expect(conversationRoute(routeState(), 'room', 'claude')).toBeUndefined();
  });

  it('a worktree with no task yet is routed too, sized medium until it has one; a main folder’s chat never', () => {
    expect(conversationRoute(routeState(), 'ws:w3', 'claude')).toMatchObject({ tasked: false, route: { size: 'medium' } });
    expect(conversationRoute(routeState(), 'ws:w2', 'claude')).toBeUndefined();
    expect(routeSummary(routeTask(task({ estimate: 3 })), 'claude', false)).toBe('No task yet, so sized medium: Opus plans and reviews, Sonnet builds, Haiku scouts');
  });

  it('names the orchestrator in each runtime’s words, and says who does what', () => {
    const route = routeTask(task({ estimate: 3 }));
    expect(routeModelLabel(route, 'claude')).toBe('Opus');
    expect(routeModelLabel(route, 'codex')).toBe('Frontier');
    expect(routeSummary(route, 'claude')).toBe('Sized medium from its task: Opus plans and reviews, Sonnet builds, Haiku scouts');
  });
});
