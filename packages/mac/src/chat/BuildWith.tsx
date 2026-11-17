import type { AgentRef } from '@beluga/protocol.js';
import { planForHome } from '@beluga/core/plans/model.js';
import { agentName } from '@beluga/shared/agent-label.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { agentOnlyItems } from '../components/agent-options.js';
import { useApi, useApp } from '../lib/beluga.js';

const sameAgent = (a: AgentRef | undefined, b: AgentRef | undefined): boolean => a?.runtime === b?.runtime && a?.model === b?.model && a?.label === b?.label;

/**
 * Plan here, build with another agent (BLG-982), from the composer's mode menu: under Plan First
 * and Plan with Tasks, "Build With ▸" picks who builds what this chat plans once you approve it.
 * The agent in this chat plans (its picker beside the mode); picking none, it builds too.
 */
export function useBuildWith(channel: string): { readonly builder?: AgentRef; readonly item: ActionItem } {
  const api = useApi();
  const runtimes = useApp((s) => s.runtimes);
  // A plan already here: its builder; else what's picked for the next plan made here.
  const builder = useApp((s) => {
    const plan = planForHome(s.plans, channel);
    return plan && plan.status !== 'done' ? plan.agent : s.buildWith[channel];
  }, sameAgent);
  const pick = (agent: AgentRef | null): void => void api.session.setBuildWith(channel, agent);
  const item: ActionItem = {
    label: builder ? `Build With ${agentName(builder)}` : 'Build With',
    hint: builder ? `${agentName(builder, { model: true })} builds it once you approve; the agent here plans it` : 'Plan with the agent here, then have another agent build it',
    icon: 'wrench',
    separate: true,
    submenu: [
      { label: 'The Agent Planning Here', hint: 'It plans and builds', checked: !builder, onSelect: () => pick(null) },
      // Just the agents, no models: the builder starts on its default; the chat's own picker changes that later.
      ...agentOnlyItems(runtimes, builder, pick).map((row, i) => (i === 0 ? { ...row, separate: true } : row)),
    ],
    onSelect: () => undefined,
  };
  return { ...(builder ? { builder } : {}), item };
}
