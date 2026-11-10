import { SUB_AGENTS, type AgentUsage, type ModelUsage, type UsageSummary } from '@beluga/core/usage-report.js';
import { formatTokens } from '@beluga/ui/work-models.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useUsageBreakdown } from '../views/usage-breakdown-state.js';
import s from './UsageBreakdown.module.css';

type UsageBreakdownProps = {
  readonly id: string;
  readonly refreshKey: string;
};

const shareOf = (part: number, whole: number): number => (whole > 0 ? Math.max(2, Math.round((part / whole) * 100)) : 0);

const ModelRow = ({ model, whole }: { readonly model: ModelUsage; readonly whole: number }) => (
  <div className={s.model}>
    <div className={s.modelHead}>
      <span className={s.name} title={model.model}>
        {model.model}
      </span>
      <span className={s.provider}>{model.provider}</span>
      <span className={s.total}>{formatTokens(model.total)}</span>
    </div>
    <span className={s.bar} aria-hidden="true">
      <span style={{ width: `${shareOf(model.total, whole)}%` }} />
    </span>
    <div className={s.split}>
      {`${model.messages} ${model.messages === 1 ? 'reply' : 'replies'} · in ${formatTokens(model.input)} · out ${formatTokens(model.output)} · cache read ${formatTokens(model.cacheRead)} · cache write ${formatTokens(model.cacheWrite)}`}
    </div>
  </div>
);

const AgentGroup = ({ agent, whole }: { readonly agent: AgentUsage; readonly whole: number }) => {
  const title = agent.agent.endsWith(SUB_AGENTS) ? 'Sub-agents' : 'This agent';
  return (
    <section className={s.group} aria-label={title}>
      <div className={s.groupHead}>
        <span>{title}</span>
        <span>{formatTokens(agent.total)}</span>
      </div>
      {agent.models.map((model) => (
        <ModelRow key={`${model.provider}/${model.model}`} model={model} whole={whole} />
      ))}
    </section>
  );
};

type UsageToggleProps = {
  readonly open: boolean;
  readonly label: string;
  readonly onToggle: () => void;
};

export const UsageToggle = ({ open, label, onToggle }: UsageToggleProps) => (
  <button type="button" className={s.toggle} aria-expanded={open} title={open ? 'Hide tokens by model' : 'Show tokens by model'} onClick={onToggle}>
    <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} aria-hidden="true" />
    {label}
  </button>
);

type UsageBreakdownViewProps = {
  readonly summary?: UsageSummary;
  readonly loading: boolean;
  readonly error?: string;
  readonly onReload: () => void;
};

export const UsageBreakdownView = ({ summary, loading, error, onReload }: UsageBreakdownViewProps) => {
  if (error) return <div className={s.note}>{error}</div>;
  if (!summary) return <div className={s.note}>{loading ? 'Reading the logs…' : 'No usage found.'}</div>;
  if (!summary.agents.length) return <div className={s.note}>No Claude Code or Codex logs for this worktree yet.</div>;
  return (
    <div className={s.breakdown}>
      {summary.agents.map((agent) => (
        <AgentGroup key={agent.agent} agent={agent} whole={summary.total} />
      ))}
      <div className={s.foot}>
        <span>{`${formatTokens(summary.total)} tokens in all, cache reads included`}</span>
        <Button size="small" variant="quiet" icon="refresh" aria-label="Read the logs again" onClick={onReload} />
      </div>
    </div>
  );
};

export const UsageBreakdown = ({ id, refreshKey }: UsageBreakdownProps) => {
  const { summary, loading, error, reload } = useUsageBreakdown(id, refreshKey);
  return <UsageBreakdownView summary={summary} loading={loading} error={error} onReload={reload} />;
};
