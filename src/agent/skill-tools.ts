import { z } from 'zod';
import { SKILL_FIX_WHEN, SKILL_NEVER_FOR, SKILL_NEW_WHEN, SKILL_NO_SECRETS } from '../shared/skill-rules.js';
import { tool, toolSuite } from './tool-kit.js';
import type { SkillTools } from './types.js';

/**
 * Your shared skills as Claude's tools (server `beluga_skills`, BLG-98): read them, and propose a new
 * one or a change to one. A proposal is a Keep / Discard card (Update / Discard for a change); nothing
 * is written until the user answers it (core/skill-proposals.ts). Available in your own runs.
 */

export const SKILL_TOOL_NAMES = ['skill_read', 'skill_propose', 'skill_propose_change'].map((n) => `mcp__beluga_skills__${n}`);

async function guarded(fn: () => string | Promise<string>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

const skillName = z.string().trim().min(1).max(64).describe('The skill’s folder name in ~/.agents/skills: lowercase letters, digits and dashes ("deploy-to-nas")');

/** What a run is told about proposing skills (INSTRUCTION_PIECES, "Skills you propose"). When one is right comes from shared/skill-rules.ts, as the reflection pass's does. */
export const buildSkillProposeAppend = (): string =>
  [
    'Shared skills (mcp__beluga_skills__*): the user’s skills live in ~/.agents/skills/<name>/SKILL.md, and every agent they run reads them. skill_read lists them or shows one.',
    `Propose a new one with skill_propose when you just finished ${SKILL_NEW_WHEN}. Propose a fix with skill_propose_change when ${SKILL_FIX_WHEN}: give the whole new SKILL.md and say what was wrong.`,
    `Do not propose for ${SKILL_NEVER_FOR}. One proposal per piece of work at most, near its end, and say in your answer that you proposed it.`,
    `The user keeps or discards each one in Needs You; nothing is written until they do. ${SKILL_NO_SECRETS}`,
  ].join(' ');

export function createSkillToolDefs(skills: SkillTools) {
  return [
    tool(
      'skill_read',
      'List the user’s shared skills (name and description), or read one skill’s SKILL.md by its name. Read a skill before you propose a change to it.',
      { name: skillName.optional().describe('A skill to read; leave out to list them all') },
      (a) => guarded(() => skills.read(a.name)),
    ),
    tool(
      'skill_propose',
      'Propose a new shared skill (~/.agents/skills/<name>/SKILL.md) when you finished multi-step work the user will likely want again. It appears as a "Keep / Discard" card and is written only when the user keeps it. Refused when the name is taken or the text holds a secret.',
      {
        name: skillName,
        description: z.string().trim().min(10).max(1024).describe('One line on what it does and when to use it: agents read it to decide whether the skill applies ("Deploy this app to the NAS. Use when asked to deploy or ship to the NAS.")'),
        body: z.string().trim().min(20).max(50_000).describe('The Markdown after the frontmatter: the steps, commands and checks, written for an agent that has never done it'),
        reason: z.string().trim().max(500).optional().describe('What you just did that this captures, in a sentence (shown on the card)'),
      },
      (a) => guarded(() => skills.propose({ name: a.name, description: a.description, body: a.body, ...(a.reason ? { reason: a.reason } : {}) })),
    ),
    tool(
      'skill_propose_change',
      'Propose a fix to a shared skill that turned out wrong or incomplete while you followed it. Give the whole new SKILL.md, frontmatter included (read it first with skill_read). It appears as an "Update / Discard" card showing what changes, and the file changes only when the user updates it.',
      {
        name: skillName,
        text: z.string().min(20).max(100_000).describe('The whole new SKILL.md, its frontmatter (name, description) included'),
        reason: z.string().trim().min(5).max(500).describe('What was wrong or missing, in a sentence (shown on the card)'),
      },
      (a) => guarded(() => skills.proposeChange({ name: a.name, text: a.text, reason: a.reason })),
    ),
  ];
}

export function createSkillTools(skills: SkillTools) {
  return toolSuite({ name: 'beluga_skills', version: '0.1.0', tools: createSkillToolDefs(skills) });
}
