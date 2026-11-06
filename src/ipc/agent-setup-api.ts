import { z } from 'zod';
import { AGENTS_DOC_MAX, SKILL_NAME_RE, SKILL_TEXT_MAX } from '../shared/agent-setup.js';

const skillName = z.string().regex(SKILL_NAME_RE);
const docRuntime = z.enum(['claude', 'codex']);

export const AGENT_SETUP_API = {
  'agentSetup.skills': { args: z.tuple([]) },
  'agentSetup.readSkill': { args: z.tuple([skillName]) },
  'agentSetup.saveSkill': { args: z.tuple([skillName, z.string().max(SKILL_TEXT_MAX), z.boolean()]) },
  'agentSetup.removeSkill': { args: z.tuple([skillName]) },
  'agentSetup.repairSkills': { args: z.tuple([]) },
  'agentSetup.agentsDoc': { args: z.tuple([]) },
  'agentSetup.saveAgentsDoc': { args: z.tuple([z.string().max(AGENTS_DOC_MAX)]) },
  'agentSetup.linkAgentsDoc': { args: z.tuple([docRuntime]) },
  'agentSetup.instructions': { args: z.tuple([]) },
} as const;
