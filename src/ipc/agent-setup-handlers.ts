import { instructionPieces } from '../agent/run-instructions.js';
import { linkAgentsDoc, listSharedSkills, readAgentsDoc, readSharedSkill, removeSharedSkill, repairSkillLinks, saveAgentsDoc, saveSharedSkill } from '../core/agent-setup.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

type AgentSetupMethod = Extract<Method, `agentSetup.${string}`>;
type AgentSetupHandlers = { readonly [M in AgentSetupMethod]: (s: Session, ...args: Args<M>) => unknown };

export const AGENT_SETUP_HANDLERS = {
  'agentSetup.skills': () => listSharedSkills(),
  'agentSetup.readSkill': (_s, name) => readSharedSkill(name),
  'agentSetup.saveSkill': (_s, name, text, create) => saveSharedSkill(name, text, create),
  'agentSetup.removeSkill': (_s, name) => removeSharedSkill(name),
  'agentSetup.repairSkills': () => repairSkillLinks(),
  'agentSetup.agentsDoc': () => readAgentsDoc(),
  'agentSetup.saveAgentsDoc': (_s, text) => saveAgentsDoc(text),
  'agentSetup.linkAgentsDoc': (_s, runtime) => linkAgentsDoc(runtime),
  'agentSetup.instructions': (s) => {
    const { prefs, self } = s.store.getState();
    return instructionPieces(self?.name ?? 'you', prefs.machineNote.trim() ? prefs.machineNote : undefined);
  },
} satisfies AgentSetupHandlers;
