import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInstructions } from '../src/agent/run-instructions.js';
import { SKILL_TOOL_NAMES } from '../src/agent/skill-tools.js';
import type { AgentRunInput, SkillTools } from '../src/agent/types.js';
import { PHONE } from '../src/companion/coverage.js';
import { waitingNeeds } from '../src/companion/needs-you.js';
import { type AgentDirs, readSharedSkill, saveSharedSkill } from '../src/core/agent-setup.js';
import { launchSkillProposals, loadSkillProposals } from '../src/core/skill-proposal-file.js';
import { MAX_PENDING_SKILLS, keepSkillProposal, newSkillText, proposeNewSkill, proposeSkillChange, skillSecret } from '../src/core/skill-proposals.js';
import { type DomainState, type SkillProposal, Store, initialState } from '../src/core/store.js';
import { AGENT_SETUP_HANDLERS } from '../src/ipc/agent-setup-handlers.js';
import type { Session } from '../src/core/session.js';
import { skillChangeDetail, skillTemplate } from '../src/shared/agent-setup.js';

const dirsFor = (): AgentDirs => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-skill-proposals-'));
  return { agents: path.join(home, '.agents'), claude: path.join(home, '.claude'), codex: path.join(home, '.codex') };
};

const skillFile = (dirs: AgentDirs, name: string): string => path.join(dirs.agents, 'skills', name, 'SKILL.md');

const deployDraft = { name: 'deploy-nas', description: 'Deploy the app to the NAS. Use when asked to deploy or ship to the NAS.', body: '# Deploy to the NAS\n\n1. Build the image.\n2. Push it to the registry.\n3. Wait for Watchtower.', reason: 'Took four tries to find the right registry.' };

const proposed = (result: ReturnType<typeof proposeNewSkill>): SkillProposal => {
  if ('error' in result) throw new Error(result.error);
  return result.proposal;
};

const withProposals = (...skillProposals: SkillProposal[]): DomainState => ({ ...initialState('room'), skillProposals });

describe('proposing a new skill', () => {
  it('writes the frontmatter from the name and description and keeps the reason', () => {
    const p = proposed(proposeNewSkill(deployDraft, 'Claude', [], dirsFor()));
    expect(p.text).toBe(newSkillText(deployDraft));
    expect(p.text.startsWith('---\nname: deploy-nas\ndescription: Deploy the app to the NAS.')).toBe(true);
    expect(p).toMatchObject({ name: 'deploy-nas', from: 'Claude', reason: deployDraft.reason });
    expect(p.previous).toBeUndefined();
  });

  it('refuses a name that is taken, with a way forward', () => {
    const dirs = dirsFor();
    saveSharedSkill('deploy-nas', skillTemplate('deploy-nas', 'Old'), true, dirs);
    const result = proposeNewSkill(deployDraft, 'Claude', [], dirs);
    expect(result).toEqual({ error: expect.stringContaining('already a skill called deploy-nas') });
  });

  it('refuses a skill holding a secret, and names what it found', () => {
    const result = proposeNewSkill({ ...deployDraft, body: `${deployDraft.body}\n\nLog in with ghp_abcdefghijklmnopqrstuvwxyz0123456789.` }, 'Claude', [], dirsFor());
    expect(result).toEqual({ error: expect.stringContaining('a GitHub token') });
  });

  it('takes a variable named for the secret', () => {
    expect(skillSecret('curl -H "Authorization: Bearer $GITHUB_TOKEN"')).toBeUndefined();
    expect(proposeNewSkill({ ...deployDraft, body: `${deployDraft.body}\n\nLog in with $REGISTRY_TOKEN.` }, 'Claude', [], dirsFor())).toHaveProperty('proposal');
  });

  it('refuses a bad name, a body with its own frontmatter, and too many waiting', () => {
    const dirs = dirsFor();
    expect(proposeNewSkill({ ...deployDraft, name: 'Deploy NAS' }, 'Claude', [], dirs)).toHaveProperty('error');
    expect(proposeNewSkill({ ...deployDraft, body: '---\nname: x\n---\nbody' }, 'Claude', [], dirs)).toHaveProperty('error');
    const pending = Array.from({ length: MAX_PENDING_SKILLS }, (_, i) => ({ ...proposed(proposeNewSkill({ ...deployDraft, name: `skill-${i}` }, 'Claude', [], dirs)) }));
    expect(proposeNewSkill(deployDraft, 'Claude', pending, dirs)).toEqual({ error: expect.stringContaining('already wait') });
  });
});

describe('proposing a change to a skill', () => {
  const setup = (): AgentDirs => {
    const dirs = dirsFor();
    saveSharedSkill('deploy-nas', newSkillText(deployDraft), true, dirs);
    return dirs;
  };

  it('keeps the skill as it is now, so the card shows what changes', () => {
    const dirs = setup();
    const text = newSkillText({ ...deployDraft, body: deployDraft.body.replace('3. Wait for Watchtower.', '3. Wait for Watchtower (about 30 seconds).') });
    const p = proposed(proposeSkillChange({ name: 'deploy-nas', text, reason: 'Watchtower takes a while.' }, 'Codex', [], dirs));
    expect(p.previous).toBe(readSharedSkill('deploy-nas', dirs));
    expect(p).toMatchObject({ text, reason: 'Watchtower takes a while.', from: 'Codex' });
  });

  it('refuses a skill that does not exist, no change, a broken frontmatter and a secret', () => {
    const dirs = setup();
    const same = readSharedSkill('deploy-nas', dirs)!;
    expect(proposeSkillChange({ name: 'nope', text: same, reason: 'x' }, 'Claude', [], dirs)).toEqual({ error: expect.stringContaining('no skill called nope') });
    expect(proposeSkillChange({ name: 'deploy-nas', text: same, reason: 'x' }, 'Claude', [], dirs)).toEqual({ error: expect.stringContaining('nothing to change') });
    expect(proposeSkillChange({ name: 'deploy-nas', text: '# no frontmatter at all', reason: 'x' }, 'Claude', [], dirs)).toHaveProperty('error');
    expect(proposeSkillChange({ name: 'deploy-nas', text: `${same}\nDATABASE_URL=postgres://user:hunter2@db/app\n`, reason: 'x' }, 'Claude', [], dirs)).toEqual({ error: expect.stringContaining('holds') });
  });
});

describe('keeping, updating and discarding', () => {
  it('Keep writes the new skill and links it for Claude', () => {
    const dirs = dirsFor();
    const p = proposed(proposeNewSkill(deployDraft, 'Claude', [], dirs));
    expect(keepSkillProposal(p, dirs)).toEqual({ ok: true });
    expect(readFileSync(skillFile(dirs, 'deploy-nas'), 'utf8')).toBe(p.text);
    const link = path.join(dirs.claude, 'skills', 'deploy-nas');
    expect(lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(path.join(dirs.agents, 'skills', 'deploy-nas'))).toBe(true);
  });

  it('Keep refuses when the name was taken since', () => {
    const dirs = dirsFor();
    const p = proposed(proposeNewSkill(deployDraft, 'Claude', [], dirs));
    saveSharedSkill('deploy-nas', skillTemplate('deploy-nas', 'Made by hand meanwhile'), true, dirs);
    expect(keepSkillProposal(p, dirs)).toEqual({ error: expect.stringContaining('already a skill') });
    expect(readFileSync(skillFile(dirs, 'deploy-nas'), 'utf8')).toContain('Made by hand meanwhile');
  });

  it('Update changes the file in place', () => {
    const dirs = dirsFor();
    saveSharedSkill('deploy-nas', newSkillText(deployDraft), true, dirs);
    const text = newSkillText({ ...deployDraft, body: `${deployDraft.body}\n4. Check the health page.` });
    const p = proposed(proposeSkillChange({ name: 'deploy-nas', text, reason: 'It forgot to check.' }, 'Claude', [], dirs));
    expect(keepSkillProposal(p, dirs)).toEqual({ ok: true });
    expect(readFileSync(skillFile(dirs, 'deploy-nas'), 'utf8')).toBe(text);
  });

  it('Discard drops the proposal and writes nothing', () => {
    const dirs = dirsFor();
    const p = proposed(proposeNewSkill(deployDraft, 'Claude', [], dirs));
    const store = new Store(withProposals(p));
    AGENT_SETUP_HANDLERS['agentSetup.discardProposal']({ store } as unknown as Session, p.id);
    expect(store.getState().skillProposals).toEqual([]);
    expect(existsSync(skillFile(dirs, 'deploy-nas'))).toBe(false);
  });

  it('Keep on a proposal already answered says so', () => {
    const store = new Store(withProposals());
    expect(() => AGENT_SETUP_HANDLERS['agentSetup.keepProposal']({ store } as unknown as Session, 'gone')).toThrow('already answered');
  });

  it('a newer proposal for the same skill takes the older one’s place', () => {
    const dirs = dirsFor();
    const first = proposed(proposeNewSkill(deployDraft, 'Claude', [], dirs));
    const second = { ...proposed(proposeNewSkill({ ...deployDraft, body: `${deployDraft.body}\n4. More.` }, 'Claude', [], dirs)), id: 'skill-second' };
    const store = new Store(withProposals(first));
    store.dispatch({ type: 'skill_proposal_add', proposal: second });
    expect(store.getState().skillProposals.map((p) => p.id)).toEqual(['skill-second']);
  });
});

describe('the card in Needs You', () => {
  it('a new skill: Keep / Discard, showing its reason and SKILL.md', () => {
    const p = proposed(proposeNewSkill(deployDraft, 'Claude', [], dirsFor()));
    const [item] = waitingNeeds(withProposals(p)).filter((n) => n.id === `skill-propose:${p.id}`);
    expect(item).toMatchObject({ kind: 'decision', from: 'Claude', title: 'Keep skill "deploy-nas" for your agents?' });
    expect(item?.detail).toBe(`${deployDraft.reason}\n\n${p.text}`);
    expect(item?.actions).toEqual([
      { label: 'Keep', tone: 'main', method: 'agentSetup.keepProposal', args: [p.id] },
      { label: 'Discard', tone: 'danger', method: 'agentSetup.discardProposal', args: [p.id] },
    ]);
  });

  it('a change: Update / Discard, showing only what changes', () => {
    const previous = ['---', 'name: a', 'description: d', '---', '', 'one', 'two', 'three', 'four', 'five', 'six'].join('\n');
    const text = previous.replace('four', 'FOUR');
    const p: SkillProposal = { id: 'skill-1', name: 'a', text, previous, reason: 'Step four was wrong.', from: 'Codex', askedAt: 1 };
    const [item] = waitingNeeds(withProposals(p));
    expect(item?.title).toBe('Update skill "a" for your agents?');
    expect(item?.actions.map((a) => a.label)).toEqual(['Update', 'Discard']);
    expect(item?.detail).toBe('Step four was wrong.\n\nBefore (from line 7):\ntwo\nthree\nfour\nfive\nsix\n\nAfter:\ntwo\nthree\nFOUR\nfive\nsix');
  });

  it('a change of the whole text still reads', () => {
    expect(skillChangeDetail('a\nb\n', 'c\n')).toBe('Before:\na\nb\n\nAfter:\nc');
  });

  it('its buttons work on the phone', () => {
    expect(PHONE['agentSetup.keepProposal']).toBe('phone');
    expect(PHONE['agentSetup.discardProposal']).toBe('phone');
  });
});

describe('what a run is told', () => {
  const input = (more: Partial<AgentRunInput> = {}): AgentRunInput => ({ prompt: 'hi', requesterName: 'kay', viaAgent: false, context: [], channel: 'ws:x', scope: 'full', signal: new AbortController().signal, onEvent: () => undefined, canUseTool: async () => ({ behavior: 'allow' }), ...more }) as AgentRunInput;
  const tools: SkillTools = { read: () => '', propose: () => '', proposeChange: () => '' };

  it('a run with the skill tools hears when proposing is right and when it is not', () => {
    const text = runInstructions(input({ skillTools: tools }), 'kay');
    expect(text).toContain('skill_propose');
    expect(text).toContain('Do not propose for a one-off');
    expect(runInstructions(input(), 'kay')).not.toContain('skill_propose');
  });

  it('names its three tools', () => {
    expect(SKILL_TOOL_NAMES).toEqual(['mcp__beluga_skills__skill_read', 'mcp__beluga_skills__skill_propose', 'mcp__beluga_skills__skill_propose_change']);
  });
});

describe('proposals across a restart', () => {
  const fileFor = (): string => path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-skill-file-')), 'skill-proposals.json');

  it('a proposal waiting for an answer is still there, with its card, after the daemon restarts', () => {
    const file = fileFor();
    const before = new Store(initialState('room'));
    const stop = launchSkillProposals({ store: before, file });
    const p = proposed(proposeNewSkill(deployDraft, 'Claude', [], dirsFor()));
    before.dispatch({ type: 'skill_proposal_add', proposal: p });
    stop();
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const after = new Store(initialState('room'));
    const stopAfter = launchSkillProposals({ store: after, file });
    expect(after.getState().skillProposals).toEqual([p]);
    expect(waitingNeeds(after.getState()).some((n) => n.id === `skill-propose:${p.id}`)).toBe(true);

    after.dispatch({ type: 'skill_proposal_remove', id: p.id });
    stopAfter();
    expect(loadSkillProposals(file)).toEqual([]);
  });

  it('never writes a proposal a secret check refuses', () => {
    const file = fileFor();
    const store = new Store(initialState('room'));
    const stop = launchSkillProposals({ store, file });
    const fine = proposed(proposeNewSkill(deployDraft, 'Claude', [], dirsFor()));
    const leaky: SkillProposal = { ...fine, id: 'skill-leak', name: 'leak', previous: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' };
    store.dispatch({ type: 'skill_proposal_add', proposal: fine });
    store.dispatch({ type: 'skill_proposal_add', proposal: leaky });
    stop();
    expect(readFileSync(file, 'utf8')).not.toContain('ghp_');
    expect(loadSkillProposals(file).map((p) => p.id)).toEqual([fine.id]);
  });
});
