import { type AgentSetupResult, SKILL_NAME_RE } from '../shared/agent-setup.js';
import { findKeys } from '../shared/key-detect.js';
import { type AgentDirs, agentDirs, readSharedSkill, saveSharedSkill, skillProblem } from './agent-setup.js';
import type { SkillProposal } from './store.js';

/**
 * Shared skills your agents propose (BLG-98), the way Toolbox's tool_propose does tools: a proposal
 * waits in Needs You until you keep it (written through agent-setup.ts, linked for Claude) or
 * discard it. Only your own skills in ~/.agents/skills; a project's skills in its repo are not.
 */

export type NewSkillDraft = { readonly name: string; readonly description: string; readonly body: string; readonly reason?: string };

export type SkillChangeDraft = { readonly name: string; readonly text: string; readonly reason: string };

export type ProposalResult = { readonly error: string } | { readonly proposal: SkillProposal };

/** At most this many wait at once: an agent that keeps proposing is told to wait for your answer. */
export const MAX_PENDING_SKILLS = 10;

/** The secret in a skill, in words ("a GitHub token"), when it has one. A key's shape alone (maybe a key) doesn't count. */
export const skillSecret = (text: string): string | undefined => findKeys(text).find((k) => k.why !== 'maybe')?.what;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A new skill's SKILL.md: frontmatter from its name and description, then the body. */
export const newSkillText = (draft: NewSkillDraft): string => `---\nname: ${draft.name}\ndescription: ${oneLine(draft.description)}\n---\n\n${draft.body.trim()}\n`;

const proposalId = (): string => `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const refusal = (name: string, text: string): string | undefined => {
  const problem = skillProblem(name, text);
  if (problem) return problem;
  const secret = skillSecret(text);
  return secret ? `That skill holds ${secret}. Skills never hold secrets: name the variable it is kept in instead.` : undefined;
};

const tooMany = (pending: readonly SkillProposal[], name: string): string | undefined =>
  pending.filter((p) => p.name !== name).length >= MAX_PENDING_SKILLS ? `${MAX_PENDING_SKILLS} skill proposals already wait for the user. Wait until they answer them.` : undefined;

/** A new skill to propose, or why not: a bad name or frontmatter, a secret, or a name that is taken. */
export const proposeNewSkill = (draft: NewSkillDraft, from: string, pending: readonly SkillProposal[], dirs: AgentDirs = agentDirs()): ProposalResult => {
  if (!SKILL_NAME_RE.test(draft.name)) return { error: 'A skill’s name is lowercase letters, digits and dashes.' };
  if (/^---\r?\n/.test(draft.body)) return { error: 'Give only the body: the name and description make the frontmatter.' };
  if (readSharedSkill(draft.name, dirs) !== undefined) return { error: `There is already a skill called ${draft.name}. Propose a change to it with skill_propose_change, or pick another name.` };
  const text = newSkillText(draft);
  const error = refusal(draft.name, text) ?? tooMany(pending, draft.name);
  if (error) return { error };
  const reason = draft.reason?.trim();
  return { proposal: { id: proposalId(), name: draft.name, text, ...(reason ? { reason } : {}), from, askedAt: Date.now() } };
};

/** A change to a skill you have, or why not: no such skill, nothing changed, bad frontmatter or a secret. */
export const proposeSkillChange = (draft: SkillChangeDraft, from: string, pending: readonly SkillProposal[], dirs: AgentDirs = agentDirs()): ProposalResult => {
  const previous = readSharedSkill(draft.name, dirs);
  if (previous === undefined) return { error: `There is no skill called ${draft.name} in ~/.agents/skills. Propose a new one with skill_propose.` };
  const text = draft.text.endsWith('\n') ? draft.text : `${draft.text}\n`;
  if (text === previous) return { error: 'That is the skill as it is now: nothing to change.' };
  const error = refusal(draft.name, text) ?? tooMany(pending, draft.name);
  if (error) return { error };
  return { proposal: { id: proposalId(), name: draft.name, text, previous, reason: draft.reason.trim(), from, askedAt: Date.now() } };
};

/** Keep (or Update): write the skill through the shared skills code, which links it for Claude. */
export const keepSkillProposal = (proposal: SkillProposal, dirs: AgentDirs = agentDirs()): AgentSetupResult => {
  const secret = skillSecret(proposal.text);
  if (secret) return { error: `That skill holds ${secret}.` };
  return saveSharedSkill(proposal.name, proposal.text, proposal.previous === undefined, dirs);
};
