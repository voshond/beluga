import { useState } from 'react';
import type { AgentRef } from '@beluga/protocol.js';
import { PLAN_ROLES, PLAN_ROLE_INFO, type Plan, type PlanRole, roleAgent } from '@beluga/core/plans/model.js';
import { agentName } from '@beluga/shared/agent-label.js';
import { agentForChoice } from '@beluga/ui/agent-choice.js';
import type { RuntimeChoice } from '@beluga/shared/agent-runtimes.js';
import { Popup } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { ActionsDropdown, type ActionItem } from '../components/SpecMenu.js';
import { Button } from '../components/ui.js';
import { YOUR_AGENT, agentOnlyItems, useAgentEntries } from '../components/agent-options.js';
import { useApp } from '../lib/beluga.js';
import { useMyAgent } from '../lib/agent-words.js';
import p from './plans.module.css';

/**
 * Who plans, who builds and who checks a plan (BLG-982), as one sentence you can read: "Planned,
 * built and checked by Claude". Tap the agent to change all three; Mix Agents splits the sentence
 * into its parts, each its own picker, for a different agent (any runtime, any model) per part.
 * Picking nothing keeps your default for everything, as before.
 */

/** Each part's pick: YOUR_AGENT or an agent picker's `runtime:model` value. */
export type RoleChoice = Readonly<Record<PlanRole, string>>;

export const ONE_AGENT: RoleChoice = { planner: YOUR_AGENT, builder: YOUR_AGENT, checker: YOUR_AGENT };

const mixed = (v: RoleChoice): boolean => v.planner !== v.builder || v.checker !== v.builder;

/**
 * The picks as plans.create takes them: `agent` builds (none: your default); a planner or checker
 * only when it differs from the builder ("your agent" then means your default, named).
 */
export function rolesInput(v: RoleChoice, runtimes: readonly RuntimeChoice[], mine: AgentRef): { agent?: AgentRef; planner?: AgentRef; checker?: AgentRef } {
  const resolve = (value: string): AgentRef => (value === YOUR_AGENT ? mine : agentForChoice(value, runtimes));
  return {
    ...(v.builder !== YOUR_AGENT ? { agent: resolve(v.builder) } : {}),
    ...(v.planner !== v.builder ? { planner: resolve(v.planner) } : {}),
    ...(v.checker !== v.builder ? { checker: resolve(v.checker) } : {}),
  };
}

export function AgentRoles({ value, onChange }: { value: RoleChoice; onChange: (v: RoleChoice) => void }) {
  const entries = useAgentEntries();
  const [split, setSplit] = useState(mixed(value));
  if (!split) {
    return (
      <div className={p.roles} role="group" aria-label="Agents">
        <span className={p.rolesWords}>Planned, built and checked by</span>
        <Popup label="Agent for every part" value={value.builder} options={entries} onChange={(v) => onChange({ planner: v, builder: v, checker: v })} />
        <button type="button" className={p.rolesSwitch} onClick={() => setSplit(true)} title="A different agent to plan, to build and to check">
          <Icon name="columns" size={11} />
          Mix Agents
        </button>
      </div>
    );
  }
  return (
    <div className={p.roles} role="group" aria-label="Agents">
      {PLAN_ROLES.map((role, i) => (
        <span key={role} className={p.rolePart} title={PLAN_ROLE_INFO[role].hint}>
          {/* One text node ("Planned by"), so a language can say it as a whole (docs/i18n.md). */}
          <span className={p.rolesWords}>{`${i === PLAN_ROLES.length - 1 ? 'and ' : ''}${PLAN_ROLE_INFO[role].verb} by`}</span>
          <Popup label={PLAN_ROLE_INFO[role].label} value={value[role]} options={entries} onChange={(v) => onChange({ ...value, [role]: v })} />
        </span>
      ))}
      <button
        type="button"
        className={p.rolesSwitch}
        onClick={() => {
          setSplit(false);
          onChange({ planner: value.builder, builder: value.builder, checker: value.builder });
        }}
        title="One agent plans, builds and checks"
      >
        One Agent
      </button>
    </div>
  );
}

/** What each part's agent is called on a plan's page ("your agent" when it follows your default). */
function roleName(plan: Plan, role: PlanRole, mine: AgentRef): string {
  const ref = roleAgent(plan, role);
  return ref ? agentName(ref) : agentName(mine);
}

/**
 * A plan's agents in its header: one name when one agent plays every part, else how many; its menu
 * names who plans, builds and checks, each a short submenu of agents (no models: each runs its
 * default) to change it from here on. `pick` gets null for "your agent" (the builder) or "same as
 * the builder" (the planner, the checker).
 */
export function PlanAgentsButton({ plan, pick }: { plan: Plan; pick: (role: PlanRole, agent: AgentRef | null) => void }) {
  const runtimes = useApp((s) => s.runtimes);
  const mine = useMyAgent();
  const names = PLAN_ROLES.map((r) => roleName(plan, r, mine));
  const one = new Set(names).size === 1;
  const items: ActionItem[] = PLAN_ROLES.map((role, i) => ({
    label: `${PLAN_ROLE_INFO[role].label}: ${names[i]}`,
    hint: PLAN_ROLE_INFO[role].hint,
    submenu: [
      role === 'builder'
        ? { label: `Your Agent (${agentName(mine)})`, hint: 'Whatever your default agent is', checked: !plan.agent, onSelect: () => pick(role, null) }
        : { label: 'Same as the Builder', hint: `${roleName(plan, 'builder', mine)} does this part too`, checked: !plan[role], onSelect: () => pick(role, null) },
      ...agentOnlyItems(runtimes, role === 'builder' ? plan.agent : plan[role], (agent) => pick(role, agent)).map((row, j) => (j === 0 ? { ...row, separate: true } : row)),
    ],
    onSelect: () => undefined,
  }));
  const tip = PLAN_ROLES.map((r, i) => `${PLAN_ROLE_INFO[r].label}: ${names[i]}`).join(' · ');
  return (
    <ActionsDropdown items={items}>
      <Button size="small" variant="quiet" icon="people" title={tip} aria-label={`Agents: ${tip}`}>
        {one ? names[0] : `${new Set(names).size} Agents`}
      </Button>
    </ActionsDropdown>
  );
}
