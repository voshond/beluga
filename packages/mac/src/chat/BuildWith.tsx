import { EFFORTS, type AgentPick, type BuildWithPick } from '@beluga/shared/settings-schema.js';
import { planForHome } from '@beluga/core/plans/model.js';
import { builderFor, pickName } from '@beluga/core/build-with.js';
import { agentName } from '@beluga/shared/agent-label.js';
import { agentForChoice } from '@beluga/ui/agent-choice.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { agentMenuItems, useAgentEntries } from '../components/agent-options.js';
import { useApi, useApp } from '../lib/beluga.js';
import { EFFORT_INFO, modelInfo } from './ModelPicker.js';

export const samePick = (a: AgentPick | undefined, b: AgentPick | undefined): boolean => a?.runtime === b?.runtime && a?.model === b?.model && a?.label === b?.label && a?.effort === b?.effort;

/**
 * Who builds (or plans, or checks) a piece of work, as menu rows: every agent and model you can
 * pick, a section per runtime, then with `effort` an "Effort ▸" row for how hard the picked one
 * thinks (only the levels its model takes). A new model keeps the effort when it takes it.
 */
export function usePickItems(): (current: AgentPick | undefined, pick: (agent: AgentPick) => void, opts?: { readonly effort?: boolean }) => ActionItem[] {
  const entries = useAgentEntries();
  const runtimes = useApp((s) => s.runtimes);
  const models = useApp((s) => s.models);
  const effortsOf = (agent: AgentPick): ReadonlySet<string> => new Set(modelInfo({ runtimes, models }, agent.runtime, agent.model ?? '')?.efforts ?? EFFORTS);
  return (current, pick, opts = {}) => {
    const pickModel = (value: string): void => {
      const agent = agentForChoice(value, runtimes);
      const effort = current?.effort && effortsOf(agent).has(current.effort) ? current.effort : undefined;
      pick({ ...agent, ...(effort ? { effort } : {}) });
    };
    const agents = agentMenuItems(
      entries.filter((e) => 'section' in e),
      current,
      pickModel,
    ).map((row, i) => (i === 0 ? { ...row, separate: true } : row));
    if (!opts.effort || !current) return agents;
    const allowed = effortsOf(current);
    const { effort: _, ...auto } = current;
    const effort: ActionItem = {
      label: `Effort: ${current.effort ? EFFORT_INFO[current.effort].label : 'Auto'}`,
      icon: 'gauge',
      separate: true,
      submenu: [
        { label: 'Auto', hint: 'It decides how hard to think, case by case', checked: !current.effort, onSelect: () => pick(auto) },
        ...EFFORTS.map((e) => ({ label: EFFORT_INFO[e].label, hint: allowed.has(e) ? EFFORT_INFO[e].detail : 'This model doesn’t take this level', checked: current.effort === e, ...(allowed.has(e) ? {} : { disabled: true }), onSelect: () => pick({ ...current, effort: e }) })),
      ],
      onSelect: () => undefined,
    };
    return [effort, ...agents];
  };
}

/**
 * Plan here, build with another agent (BLG-982), from the composer's mode menu: under Plan First
 * and Plan with Tasks (a new worktree's or chat's too), "Build With ▸" picks who builds what this
 * chat plans once you approve it: any agent and model, and how hard it thinks. The agent in this
 * chat plans (its picker beside the mode). Settings › Agent › Build plans with is where it starts.
 */
export function useBuildWith(channel: string): { readonly builder?: AgentPick; readonly item: ActionItem } {
  const api = useApi();
  const pickItems = usePickItems();
  const planHere = useApp((s) => {
    const plan = planForHome(s.plans, channel);
    return Boolean(plan && plan.status !== 'done');
  });
  // A plan already here: its builder; else what's picked for the next plan made here, else Settings'.
  const builder = useApp((s) => {
    const plan = planForHome(s.plans, channel);
    return plan && plan.status !== 'done' ? plan.agent : builderFor(s, channel);
  }, samePick);
  const fallback = useApp((s) => s.prefs.buildWith, samePick);
  const following = useApp((s) => s.buildWith[channel] === undefined);
  const set = (agent: BuildWithPick | null): void => void api.session.setBuildWith(channel, agent);
  const yours: ActionItem[] = fallback
    ? [{ label: `Your Default (${agentName(fallback, { model: true })})`, hint: 'Settings › Agent › Build plans with', checked: !planHere && following, onSelect: () => set(null) }]
    : [];
  const item: ActionItem = {
    label: builder ? `Build With ${agentName(builder, { model: true })}` : 'Build With',
    hint: builder ? `${pickName(builder)} builds it once you approve; the agent here plans it` : 'Plan with the agent here, then have another agent or model build it',
    icon: 'wrench',
    separate: true,
    submenu: [
      { label: 'The Agent Planning Here', hint: 'It plans and builds', checked: !builder, onSelect: () => set(fallback || planHere ? 'here' : null) },
      ...yours,
      ...pickItems(builder, set, { effort: true }),
    ],
    onSelect: () => undefined,
  };
  return { ...(builder ? { builder } : {}), item };
}
