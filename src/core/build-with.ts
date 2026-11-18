import type { AgentPick, BuildWithPick } from '../shared/settings-schema.js';
import { agentName } from '../shared/agent-label.js';

type BuildWithState = { readonly buildWith: Readonly<Record<string, BuildWithPick>>; readonly prefs: { readonly buildWith?: AgentPick } };

/**
 * Who builds what's planned in a chat once you approve it: the chat's own Build With pick, else
 * Settings › Agent's default; undefined (or a pick of 'here'): the agent that planned it builds it too.
 */
export const builderFor = (state: BuildWithState, channel: string): AgentPick | undefined => {
  const picked = state.buildWith[channel];
  if (picked === 'here') return undefined;
  return picked ?? state.prefs.buildWith;
};

/** A builder in words, with its model and effort ("Claude Sonnet, low effort"). */
export const pickName = (pick: AgentPick): string => `${agentName(pick, { model: true })}${pick.effort ? `, ${pick.effort} effort` : ''}`;
