import { runtimeHas, runtimeHere } from '@beluga/shared/runtime-fallbacks.js';
import { useApp } from '../lib/beluga.js';
import type { SteerBlock } from './send-action.js';

/**
 * Why a message sent now in `channel` can't steer its running turn, or undefined when it can. In
 * Plan First the host stops the turn for it instead (a plan message is never steered in), so it queues.
 */
export function useSteerBlock(channel: string): SteerBlock | undefined {
  return useApp((st) => {
    if (st.planMode[channel] === true) return 'plan';
    const agent = st.projects.flatMap((p) => p.workspaces).find((w) => `ws:${w.id}` === channel)?.agent;
    return runtimeHas(runtimeHere(agent, st.self), 'steer') ? undefined : 'agent';
  });
}
