import { EFFORTS, type AgentPick, type BuildWithPick } from '@beluga/shared/settings-schema.js';
import { planForHome } from '@beluga/core/plans/model.js';
import { builderFor, pickName } from '@beluga/core/build-with.js';
import { agentName } from '@beluga/shared/agent-label.js';
import { agentForChoice } from '@beluga/ui/agent-choice.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { Icon } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { agentMenuItems, useAgentEntries } from '../components/agent-options.js';
import { useApi, useApp } from '../lib/beluga.js';
import { EFFORT_INFO, modelInfo } from './ModelPicker.js';
import s from './composer.module.css';

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
 * and Advanced Planning (a new worktree's or chat's too), "Builder ▸" picks who builds what this
 * chat plans once you approve it: any agent and model, and how hard it thinks. The agent in this
 * chat plans (its picker beside the mode). Settings › Agent › Build plans with is where it starts.
 *
 * BLG-1023: the row says who builds ("Builder: Codex") and a pick keeps the menu open, so the choice
 * shows where it was made; a chip beside the mode says it once the menu closes, with × to undo it.
 * Only when there is someone to pick: with no usable agent the row isn't there at all.
 */
export function useBuildWith(channel: string): { readonly builder?: AgentPick; readonly show: boolean; readonly clear: () => void; readonly item: ActionItem } {
  const api = useApi();
  const pickItems = usePickItems();
  const usable = useApp((s) => s.runtimes.some((r) => r.available));
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
  const here = (): void => set(fallback || planHere ? 'here' : null);
  const yours: ActionItem[] = fallback
    ? [{ label: `Your Default (${agentName(fallback, { model: true })})`, hint: 'Settings › Agent › Build plans with', checked: !planHere && following, stay: true, onSelect: () => set(null) }]
    : [];
  const show = usable || builder !== undefined;
  const item: ActionItem = {
    label: `Builder: ${builder ? agentName(builder, { model: true }) : 'The Agent Planning Here'}`,
    hint: builder ? `${pickName(builder)} builds it once you approve; the agent here plans it` : 'Plan with the agent here, then have another agent or model build it',
    icon: 'wrench',
    separate: true,
    submenu: [
      { label: 'The Agent Planning Here', hint: 'It plans and builds', checked: !builder, stay: true, onSelect: here },
      ...yours,
      ...pickItems(builder, set, { effort: true }).map((row) => (row.submenu ? row : { ...row, stay: true })),
    ],
    onSelect: () => undefined,
  };
  return { ...(builder ? { builder } : {}), show, clear: here, item };
}

/** Beside the mode while another agent will build what's planned here: who, and × to have the agent here build it. */
export function BuildWithChip({ builder, clear }: { builder: AgentPick; clear: () => void }) {
  const name = agentName(builder, { model: true });
  return (
    <Tip label={`${name} does the work once you approve the plan. Click to have the agent here build it too`}>
      <button type="button" className={cx(s.chip, s.chipOn)} aria-label={`Built by ${name}: have the agent here build it instead`} onClick={clear}>
        <Icon name="wrench" size={12} />
        <span className={s.chipLabel}>Built by {name}</span>
        <Icon name="x" size={9} />
      </button>
    </Tip>
  );
}
