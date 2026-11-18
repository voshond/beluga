import { instructionPieces } from '../agent/run-instructions.js';
import { linkAgentsDoc, listSharedSkills, readAgentsDoc, readSharedSkill, removeSharedSkill, repairSkillLinks, saveAgentsDoc, saveSharedSkill } from '../core/agent-setup.js';
import type { Session } from '../core/session.js';
import { keepSkillProposal } from '../core/skill-proposals.js';
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
  'agentSetup.keepProposal': (s, id) => {
    const proposal = s.store.getState().skillProposals.find((p) => p.id === id);
    if (!proposal) throw new Error('That skill proposal was already answered.');
    const result = keepSkillProposal(proposal);
    if ('error' in result) throw new Error(result.error);
    s.store.dispatch({ type: 'skill_proposal_remove', id });
    return result;
  },
  'agentSetup.discardProposal': (s, id) => {
    s.store.dispatch({ type: 'skill_proposal_remove', id });
  },
} satisfies AgentSetupHandlers;
