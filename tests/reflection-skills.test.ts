import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSkillProposeAppend } from '../src/agent/skill-tools.js';
import { waitingNeeds } from '../src/companion/needs-you.js';
import { type AgentDirs, readSharedSkill, saveSharedSkill } from '../src/core/agent-setup.js';
import { Reflection, type ReflectionAsk, launchReflection, loadReflection } from '../src/core/memory/reflection.js';
import { type RunStep, SKILL_MIN_STEPS, SKILL_SYSTEM, runStepsFrom, skillDraftFrom, skillSource } from '../src/core/memory/reflection-skills.js';
import { MemoryStore } from '../src/core/memory/store.js';
import { MAX_PENDING_SKILLS, keepSkillProposal } from '../src/core/skill-proposals.js';
import type { Session } from '../src/core/session.js';
import { type Action, type SkillProposal, Store, initialState } from '../src/core/store.js';
import { AGENT_SETUP_HANDLERS } from '../src/ipc/agent-setup-handlers.js';
import { skillTemplate } from '../src/shared/agent-setup.js';
import { SKILL_FIX_WHEN, SKILL_NEVER_FOR, SKILL_NEW_WHEN } from '../src/shared/skill-rules.js';
import type { StepRecord } from '../src/shared/steps.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const SELF = 'me';
const NOW = new Date(2026, 10, 18, 12).getTime();
const ROOT = '/code/app';
const CH = 'ws:a';
const RUN = `${SELF}:r1`;

const ws = (id: string): Workspace => ({ id, projectId: 'p1', projectRoot: ROOT, name: `task ${id}`, path: `/wt/${id}`, kind: 'worktree', branch: `beluga/${id}`, createdAt: NOW, external: false });
const project = (workspaces: Workspace[]): Project => ({ id: 'p1', name: 'app', root: ROOT, base: 'origin/main', workspaces });

const tempDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-reflection-skills-'));

const dirsFor = (): AgentDirs => {
  const home = tempDir();
  return { agents: path.join(home, '.agents'), claude: path.join(home, '.claude'), codex: path.join(home, '.codex') };
};

let n = 0;
const said = (text: string, byAgent = false): Action => ({ type: 'chat', id: `m-${n++}`, from: SELF, text, ts: NOW + n, byAgent, channel: CH });

const DEPLOY_STEPS: readonly RunStep[] = [
  { title: 'Bash docker build -t docker-registry.example.io/app:latest .' },
  { title: 'Bash docker push registry.example.io/app:latest', failed: true },
  { title: 'Bash docker login docker-registry.example.io' },
  { title: 'Bash docker push docker-registry.example.io/app:latest' },
  { title: 'Bash ssh nas docker compose pull' },
  { title: 'Bash ssh nas docker compose up -d' },
  { title: 'Bash curl -fsS https://app.example.io/health' },
  { title: 'Read docs/deploy.md' },
];

const DEPLOY_BODY = [
  '# Deploy the app to the NAS',
  '',
  '1. Build the image: `docker build -t docker-registry.example.io/app:latest .`',
  '2. Log in first, or the push is refused: `docker login docker-registry.example.io`',
  '3. Push it: `docker push docker-registry.example.io/app:latest`',
  '4. On the NAS, pull and restart:',
  '',
  '```sh',
  'ssh nas docker compose pull',
  'ssh nas docker compose up -d',
  '```',
  '',
  '5. Check it is up: `curl -fsS https://app.example.io/health` answers 200.',
].join('\n');

const newBlock = (more: { name?: string; description?: string; body?: string; reason?: string } = {}): string =>
  [
    `<skill kind="new" name="${more.name ?? 'deploy-nas'}">`,
    `<description>${more.description ?? 'Deploy the app to the NAS. Use when asked to deploy or ship to the NAS.'}</description>`,
    `<reason>${more.reason ?? 'The push failed until the right registry and a login were found.'}</reason>`,
    `<body>\n${more.body ?? DEPLOY_BODY}\n</body>`,
    '</skill>',
  ].join('\n');

const fixBlock = (text: string, evidence: string, name = 'deploy-nas'): string => `<skill kind="fix" name="${name}">\n<reason>It names the old registry.</reason>\n<evidence>${evidence}</evidence>\n<text>\n${text}\n</text>\n</skill>`;

type Call = { prompt: string; system: string; model: string };

const setup = (skillAnswer: string, opts: { steps?: readonly RunStep[]; file?: string | null; dirs?: AgentDirs } = {}) => {
  const store = new Store(initialState('test', 'ask'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true });
  store.dispatch({ type: 'projects', projects: [project([ws('a')])] });
  const dirs = opts.dirs ?? dirsFor();
  const calls: Call[] = [];
  const ask: ReflectionAsk = async (req) => {
    calls.push(req);
    return req.system === SKILL_SYSTEM ? skillAnswer : '{"proposals":[]}';
  };
  const steps = new Map<string, readonly RunStep[]>([[RUN, opts.steps ?? DEPLOY_STEPS]]);
  const reflection = new Reflection({ store, ask, sharedWith: () => false, memory: new MemoryStore(tempDir()), file: opts.file ?? null, now: () => NOW, dirs, runSteps: (_channel, itemId) => steps.get(itemId) });
  const skillCalls = (): Call[] => calls.filter((c) => c.system === SKILL_SYSTEM);
  return { store, reflection, calls, skillCalls, dirs, steps };
};

/** A conversation long enough to look back at, with one run of the agent. */
const work = (store: Store, answer = 'Deployed. The push needed docker-registry.example.io and a login first.'): void => {
  store.dispatch(said('Deploy the app to the NAS.'));
  store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'started', text: '', ts: NOW, channel: CH, itemId: RUN });
  store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'done', text: answer, ts: NOW + 1, channel: CH });
  store.dispatch(said('The health check too, please.'));
  store.dispatch(said('It answers 200.', true));
  store.dispatch(said('Good, thanks.'));
  store.dispatch(said('Anything else to do?'));
  store.dispatch(said('No, it is live.', true));
};

const OLD_SKILL = `${skillTemplate('deploy-nas', 'Deploy the app to the NAS.')}1. docker push registry.example.io/app:latest\n`;
const FIXED_SKILL = `${skillTemplate('deploy-nas', 'Deploy the app to the NAS.')}1. docker login docker-registry.example.io\n2. docker push docker-registry.example.io/app:latest\n`;
const USED: RunStep = { title: 'Skill deploy-nas', skill: 'deploy-nas' };
const EVIDENCE = 'Agent ran: Bash docker push registry.example.io/app:latest [failed]';

describe('a new skill', () => {
  it('proposes one after multi-step work, as the Keep / Discard card with the whole SKILL.md, on the stronger model', async () => {
    const { store, reflection, skillCalls, calls, dirs } = setup(newBlock());
    work(store);
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 1, skill: 'new' });
    expect(calls.map((c) => c.model)).toEqual(['haiku', 'sonnet']);
    expect(skillCalls()[0]?.prompt).toContain('Agent ran: Bash docker push registry.example.io/app:latest [failed]');
    const [p] = store.getState().skillProposals;
    expect(p).toMatchObject({ name: 'deploy-nas', from: 'Beluga', askedAt: NOW });
    expect(p!.text.startsWith('---\nname: deploy-nas\ndescription: Deploy the app to the NAS.')).toBe(true);
    expect(p!.previous).toBeUndefined();
    const card = waitingNeeds(store.getState()).find((i) => i.id === `skill-propose:${p!.id}`);
    expect(card?.actions.map((a) => a.label)).toEqual(['Keep', 'Discard']);
    expect(card?.detail).toContain('ssh nas docker compose up -d');
    expect(keepSkillProposal(p!, dirs)).toMatchObject({ ok: true });
    expect(readSharedSkill('deploy-nas', dirs)).toBe(p!.text);
  });

  it('uses the skill model picked in Settings', async () => {
    const { store, reflection, skillCalls } = setup('NOTHING');
    store.dispatch({ type: 'prefs', prefs: { reflectionSkillModel: 'opus' } });
    work(store);
    await reflection.reflect(CH, 'manual');
    expect(skillCalls()[0]?.model).toBe('opus');
  });

  it('proposes at most one', async () => {
    const { store, reflection } = setup(`${newBlock()}\n${newBlock({ name: 'deploy-again' })}`);
    work(store);
    await reflection.reflect(CH, 'manual');
    expect(store.getState().skillProposals.length).toBeLessThanOrEqual(1);
  });
});

describe('nothing', () => {
  it('a short or simple conversation gets only the memory look', async () => {
    const { store, reflection, calls } = setup(newBlock(), { steps: DEPLOY_STEPS.slice(0, SKILL_MIN_STEPS - 1) });
    work(store);
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
    expect(calls.map((c) => c.model)).toEqual(['haiku']);
  });

  it('the model says NOTHING for a one-off, what the docs say or a preference: no card', async () => {
    const { store, reflection, skillCalls } = setup('NOTHING');
    work(store);
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
    expect(skillCalls()).toHaveLength(1);
    expect(store.getState().skillProposals).toHaveLength(0);
  });

  it('drops a thin skill, one with no code, and one whose commands were never run', async () => {
    for (const body of ['Build it, push it, restart it.', `${'Think carefully about each step before you take it. '.repeat(8)}`, `${DEPLOY_BODY.replace(/docker|ssh|curl/g, 'kubectl')}`]) {
      const { store, reflection } = setup(newBlock({ body }));
      work(store);
      expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
    }
  });

  it('drops one that fails the existing checks: a bad name, a secret', async () => {
    for (const block of [newBlock({ name: 'Deploy NAS' }), newBlock({ body: `${DEPLOY_BODY}\n\nToken: ghp_0123456789abcdefghijABCDEFGHIJ012345` })]) {
      const { store, reflection } = setup(block);
      work(store);
      expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
      expect(waitingNeeds(store.getState()).filter((i) => i.id.startsWith('skill-propose:'))).toHaveLength(0);
    }
  });

  it('never proposes a skill that is already there, and tells the model which exist', async () => {
    const dirs = dirsFor();
    saveSharedSkill('deploy-nas', OLD_SKILL, true, dirs);
    const { store, reflection, skillCalls } = setup(newBlock(), { dirs });
    work(store);
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
    expect(skillCalls()[0]?.prompt).toContain('- deploy-nas: Deploy the app to the NAS.');
  });

  it('never proposes one that already waits', async () => {
    const { store, reflection } = setup(newBlock());
    const waiting: SkillProposal = { id: 'w', name: 'deploy-nas', text: OLD_SKILL, from: 'Claude', askedAt: 1 };
    store.dispatch({ type: 'skill_proposal_add', proposal: waiting });
    work(store);
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
    expect(store.getState().skillProposals).toEqual([waiting]);
  });

  it('makes no call when as many proposals wait as may', async () => {
    const { store, reflection, skillCalls } = setup(newBlock());
    for (let i = 0; i < MAX_PENDING_SKILLS; i++) store.dispatch({ type: 'skill_proposal_add', proposal: { id: `w${i}`, name: `waiting-${i}`, text: OLD_SKILL, from: 'Claude', askedAt: i } });
    work(store);
    await reflection.reflect(CH, 'manual');
    expect(skillCalls()).toHaveLength(0);
  });

  it('never proposes one you discarded before, by its name or its description, across a restart', async () => {
    const file = path.join(tempDir(), 'memory-reflection.json');
    const first = setup(newBlock(), { file });
    work(first.store);
    const stop = first.reflection.start();
    await first.reflection.reflect(CH, 'manual');
    first.reflection.skillDiscarded(first.store.getState().skillProposals[0]!);
    first.store.dispatch({ type: 'skill_proposal_remove', id: first.store.getState().skillProposals[0]!.id });
    stop();
    expect(loadReflection(file).skills).toEqual([{ name: 'deploy-nas', description: 'Deploy the app to the NAS. Use when asked to deploy or ship to the NAS.' }]);

    for (const name of ['deploy-nas', 'ship-to-nas']) {
      const again = setup(newBlock({ name }), { file });
      work(again.store);
      expect(await again.reflection.reflect(CH, 'merge')).toEqual({ proposed: 0 });
      expect(again.skillCalls()[0]?.prompt).toContain('- deploy-nas: Deploy the app to the NAS.');
    }
  });

  it('Discard on any skill card is remembered, an agent’s proposal too', () => {
    const file = path.join(tempDir(), 'memory-reflection.json');
    const store = new Store(initialState('test', 'ask'));
    const session = { store } as Session;
    const stop = launchReflection({ session, store, ask: async () => 'NOTHING', sharedWith: () => false, file });
    store.dispatch({ type: 'skill_proposal_add', proposal: { id: 'w', name: 'deploy-nas', text: OLD_SKILL, from: 'Claude', askedAt: 1 } });
    AGENT_SETUP_HANDLERS['agentSetup.discardProposal'](session, 'w');
    stop();
    expect(store.getState().skillProposals).toHaveLength(0);
    expect(loadReflection(file).skills).toEqual([{ name: 'deploy-nas', description: 'Deploy the app to the NAS.' }]);
  });

  it('is off with reflection, and with its own switch', async () => {
    const off = setup(newBlock());
    off.store.dispatch({ type: 'prefs', prefs: { reflection: false } });
    work(off.store);
    expect(await off.reflection.reflect(CH, 'manual')).toMatchObject({ skipped: 'off' });
    expect(off.calls).toHaveLength(0);

    const memoryOnly = setup(newBlock());
    memoryOnly.store.dispatch({ type: 'prefs', prefs: { reflectionSkills: false } });
    work(memoryOnly.store);
    expect(await memoryOnly.reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
    expect(memoryOnly.calls.map((c) => c.model)).toEqual(['haiku']);
  });

  it('a skill look that fails leaves the memory look standing', async () => {
    const { store } = setup('');
    work(store);
    const ask: ReflectionAsk = async (req) => (req.system === SKILL_SYSTEM ? Promise.reject(new Error('it took too long')) : '{"proposals":[{"scope":"user","text":"Deploys to the NAS."}]}');
    const reflection = new Reflection({ store, ask, sharedWith: () => false, memory: new MemoryStore(tempDir()), file: null, dirs: dirsFor(), runSteps: () => DEPLOY_STEPS });
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 1 });
    expect(store.getState().memoryProposals).toHaveLength(1);
  });
});

describe('a skill the agent proposed during the run', () => {
  it('is not proposed again: no new skill, under any name', async () => {
    const { store, reflection, skillCalls } = setup(newBlock({ name: 'ship-to-nas' }));
    work(store);
    store.dispatch({ type: 'agent_learned', owner: SELF, requestId: 'r1', mark: { id: 'k1', kind: 'skill', ts: NOW, proposal: 'gone', name: 'deploy-nas', update: false } });
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
    expect(skillCalls()).toHaveLength(0);
  });

  it('a fix the agent proposed is not proposed again, while a new skill still may be', async () => {
    const dirs = dirsFor();
    saveSharedSkill('deploy-nas', OLD_SKILL, true, dirs);
    const { store, reflection, skillCalls } = setup(fixBlock(FIXED_SKILL, EVIDENCE), { dirs, steps: [USED, ...DEPLOY_STEPS] });
    work(store);
    store.dispatch({ type: 'agent_learned', owner: SELF, requestId: 'r1', mark: { id: 'k1', kind: 'skill', ts: NOW, proposal: 'gone', name: 'deploy-nas', update: true } });
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
    expect(skillCalls()[0]?.prompt).toContain('(none: no fix)');
  });
});

describe('a fix', () => {
  it('proposes a change to a skill the run used and that was shown wrong, as the Update / Discard card with what changes', async () => {
    const dirs = dirsFor();
    saveSharedSkill('deploy-nas', OLD_SKILL, true, dirs);
    const { store, reflection, skillCalls } = setup(fixBlock(FIXED_SKILL, EVIDENCE), { dirs, steps: [USED, ...DEPLOY_STEPS.slice(0, 4)] });
    work(store);
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 1, skill: 'change' });
    expect(skillCalls()[0]?.prompt).toContain(`<used_skill name="deploy-nas">\n${OLD_SKILL}`);
    expect(skillCalls()[0]?.prompt).toContain('A new skill: not allowed here');
    const [p] = store.getState().skillProposals;
    expect(p).toMatchObject({ name: 'deploy-nas', text: FIXED_SKILL, previous: OLD_SKILL, reason: 'It names the old registry.', from: 'Beluga' });
    const card = waitingNeeds(store.getState()).find((i) => i.id === `skill-propose:${p!.id}`);
    expect(card?.actions.map((a) => a.label)).toEqual(['Update', 'Discard']);
    expect(card?.detail).toContain('docker login docker-registry.example.io');
  });

  it('needs a sign from the conversation: a quote that is not in it gives no card', async () => {
    const dirs = dirsFor();
    saveSharedSkill('deploy-nas', OLD_SKILL, true, dirs);
    const { store, reflection } = setup(fixBlock(FIXED_SKILL, 'The user said the skill was completely wrong.'), { dirs, steps: [USED, ...DEPLOY_STEPS] });
    work(store);
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
  });

  it('never fixes a skill the run did not use', async () => {
    const dirs = dirsFor();
    saveSharedSkill('deploy-nas', OLD_SKILL, true, dirs);
    const { store, reflection } = setup(fixBlock(FIXED_SKILL, EVIDENCE), { dirs });
    work(store);
    expect(await reflection.reflect(CH, 'manual')).toEqual({ proposed: 0 });
  });

  it('a fix you discarded is not proposed again while the skill stays as it was', async () => {
    const dirs = dirsFor();
    saveSharedSkill('deploy-nas', OLD_SKILL, true, dirs);
    const { store, reflection, skillCalls } = setup(fixBlock(FIXED_SKILL, EVIDENCE), { dirs, steps: [USED, ...DEPLOY_STEPS.slice(0, 4)] });
    work(store);
    await reflection.reflect(CH, 'manual');
    const [p] = store.getState().skillProposals;
    reflection.skillDiscarded(p!);
    store.dispatch({ type: 'skill_proposal_remove', id: p!.id });
    expect(await reflection.reflect(CH, 'merge')).toEqual({ proposed: 0 });
    expect(skillCalls()).toHaveLength(1);
  });
});

describe('what it reads', () => {
  it('finds a used skill by the step that loaded it or by its path, and counts the steps', () => {
    const { store, steps } = setup('NOTHING', { steps: [{ title: 'Read ~/.agents/skills/release/SKILL.md' }, USED, { title: 'Bash npm test' }] });
    work(store);
    const source = skillSource(store.getState(), CH, (_c, id) => steps.get(id), ['deploy-nas', 'release', 'unused']);
    expect(source.used).toEqual(['deploy-nas', 'release']);
    expect(source.steps).toBe(3);
    expect(source.lines).toContain('Agent ran: Bash npm test');
  });

  it('reads a run’s steps from the step book: the whole command, failures, the skill loaded', () => {
    const record = (id: string, tool: string, title: string, input: StepRecord['input'], status: StepRecord['status'] = 'done'): StepRecord => ({ id, kind: 'tool', tool, title, status, startedAt: NOW, input });
    const long = `docker build ${'--build-arg A=1 '.repeat(8)}.`;
    const records = [record('s1', 'Bash', 'Bash docker build --build-arg...', { command: long }, 'error'), record('s2', 'Skill', 'Skill', { skill: 'deploy-nas' }), record('s3', 'Read', 'Read src/app.ts', {})];
    const thought: StepRecord = { id: 't', kind: 'thinking', title: 'Thought for 3s', status: 'done', startedAt: NOW };
    const read = runStepsFrom({ stepsFor: (_c, item) => (item === 'x' ? { steps: [...records, thought], version: 1 } : { steps: [], version: 0, missing: true }), stepFor: (_c, _i, id) => records.find((r) => r.id === id) });
    expect(read(CH, 'x')).toEqual([{ title: `Bash ${long}`, failed: true }, { title: 'Skill deploy-nas', skill: 'deploy-nas' }, { title: 'Read src/app.ts' }]);
    expect(read(CH, 'none')).toBeUndefined();
  });

  it('redacts secrets in steps before the model sees them', async () => {
    const { store, reflection, skillCalls } = setup('NOTHING', { steps: [...DEPLOY_STEPS, { title: 'Bash curl -H "x: ghp_0123456789abcdefghijABCDEFGHIJ012345" https://api.example.io' }] });
    work(store);
    await reflection.reflect(CH, 'manual');
    expect(skillCalls()[0]?.prompt).not.toContain('ghp_0123456789abcdefghijABCDEFGHIJ012345');
  });

  it('reads the answer as one whole block or nothing', () => {
    expect(skillDraftFrom('NOTHING')).toBeUndefined();
    expect(skillDraftFrom('<skill kind="new" name="x"><description>d</description>')).toBeUndefined();
    expect(skillDraftFrom(`Here:\n${newBlock()}`)).toMatchObject({ kind: 'new', name: 'deploy-nas', body: DEPLOY_BODY });
  });
});

describe('the rules', () => {
  it('come from one text shared with what an agent is told', () => {
    for (const rule of [SKILL_NEW_WHEN, SKILL_FIX_WHEN, SKILL_NEVER_FOR]) {
      expect(SKILL_SYSTEM).toContain(rule);
      expect(buildSkillProposeAppend()).toContain(rule);
    }
  });
});
