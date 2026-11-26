import { useRef, useState } from 'react';
import type { InitiativeView } from '@beluga/core/initiatives/model.js';
import { type SuccessDefinition, type SuccessDraft, type SuccessMetric, type SuccessProposalInput, VERDICT_WORDS, formatSuccessNumber, keptNames, scopeChange, verdictOf } from '@beluga/core/initiatives/success.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { Section } from './InitiativeParts.js';
import { SuccessProposalCard } from './SuccessProposal.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';
import own from './success.module.css';

type DefineState = { readonly kind: 'idle' } | { readonly kind: 'working' } | { readonly kind: 'draft'; readonly draft: SuccessDraft } | { readonly kind: 'error'; readonly message: string };

const MetricRow = ({ metric, sentinel }: { metric: SuccessMetric; sentinel: string | undefined }) => {
  const latest = useApp((st) => (sentinel ? st.sentinel.metrics?.[sentinel]?.[keptNames(metric.name).value]?.points.at(-1)?.value : undefined));
  const verdict = verdictOf(latest, metric);
  const f = (v: number | undefined): string => formatSuccessNumber(v, metric.unit);
  return (
    <li className={own.metric} data-success-metric={metric.name} data-verdict={verdict}>
      <span className={own.metricHead}>
        <span className={own.metricName}>{metric.label}</span>
        <span className={own.now} aria-label={`${metric.label} now`}>
          {f(latest)}
        </span>
        <span className={own.verdict}>{VERDICT_WORDS[verdict]}</span>
      </span>
      <span className={s.quiet}>
        Baseline {f(metric.baseline)} · target {f(metric.target)} · {metric.direction === 'up' ? 'higher' : 'lower'} is better
      </span>
      <span className={s.quiet}>Counts: {metric.attribution}</span>
    </li>
  );
};

const Definition = ({ item, definition }: { item: InitiativeView; definition: SuccessDefinition }) => {
  const actions = useActions();
  const paused = useApp((st) => st.sentinel.items.find((x) => x.id === definition.sentinel)?.paused);
  const hasBoard = useApp((st) => Boolean(definition.dashboard && st.sentinel.dashboards?.some((d) => d.id === definition.dashboard)));
  const scope = item.tickets ? scopeChange(definition.scope, item.tickets.tickets.map((t) => t.key)) : undefined;
  const handleBoard = (): void => actions.run({ type: 'view', view: { kind: 'dashboard', id: definition.dashboard } });
  const handleSentinel = (): void => {
    if (definition.sentinel) actions.run({ type: 'view', view: { kind: 'sentinel_page', id: definition.sentinel } });
  };
  return (
    <div className={own.definition} data-success="defined">
      <p className={s.lede}>{definition.summary}</p>
      <ul className={own.metrics}>
        {definition.metrics.map((m) => (
          <MetricRow key={m.name} metric={m} sentinel={definition.sentinel} />
        ))}
      </ul>
      {scope ? (
        <div className={s.trouble} role="status" data-success="scope">
          <Icon name="alert" size={12} />
          Tickets changed since this was defined ({scope.added.length} added, {scope.removed.length} gone): Define Success again if it changes what counts.
        </div>
      ) : null}
      <span className={s.buttons}>
        {hasBoard ? (
          <Button size="small" icon="gauge" onClick={handleBoard}>
            Open Dashboard
          </Button>
        ) : null}
        {definition.sentinel && paused !== undefined ? (
          <Button size="small" variant="quiet" onClick={handleSentinel} aria-label={`Open its sentinel${paused ? ', paused' : ''}`}>
            {paused ? 'Sentinel paused: turn it on to keep the numbers' : 'Sentinel keeps the numbers daily'}
          </Button>
        ) : null}
        {item.success?.shippedAt ? <span className={s.quiet}>Shipped {item.success.shippedAt.slice(0, 10)}: the check-in reviews the outcome weekly.</span> : null}
      </span>
    </div>
  );
};

export const SuccessSection = ({ item }: { item: InitiativeView }) => {
  const a = useInitiativeActions();
  const [state, setState] = useState<DefineState>({ kind: 'idle' });
  const [accepting, setAccepting] = useState(false);
  const run = useRef(0);
  const definition = item.success?.definition;
  const handleDefine = (): void => {
    run.current += 1;
    const mine = run.current;
    setState({ kind: 'working' });
    a.api.defineSuccess(item.slug).then(
      (draft) => mine === run.current && setState({ kind: 'draft', draft }),
      (err: Error) => mine === run.current && setState({ kind: 'error', message: err.message.replace(/^Error: /, '') }),
    );
  };
  const handleReject = (): void => {
    run.current += 1;
    setState({ kind: 'idle' });
  };
  const handleAccept = async (proposal: SuccessProposalInput): Promise<void> => {
    setAccepting(true);
    const made = await a.act(() => a.api.acceptSuccess(item.slug, proposal as Parameters<typeof a.api.acceptSuccess>[1]), 'Success defined: its sentinel is paused until you turn it on');
    setAccepting(false);
    if (made) setState({ kind: 'idle' });
  };
  const aside = (
    <Button size="small" icon="sparkles" onClick={handleDefine} disabled={Boolean(item.trouble) || state.kind === 'working'} aria-label="Define success with your agent">
      {state.kind === 'working' ? 'Defining…' : definition ? 'Define Again' : 'Define Success'}
    </Button>
  );
  return (
    <Section title="Success" aside={aside}>
      {definition ? <Definition item={item} definition={definition} /> : <p className={s.lede}>Not defined yet: your agent proposes what to measure from the goal, the tickets, the linked repos and BigQuery.</p>}
      {state.kind === 'working' ? (
        <div className={s.draft} role="status" data-success="working">
          <span className={s.quiet}>Your agent is reading the tickets, the data model and the BigQuery schema, and trying queries. This takes a few minutes.</span>
          <span className={s.buttons}>
            <Button size="small" variant="quiet" onClick={handleReject}>
              Stop
            </Button>
          </span>
        </div>
      ) : null}
      {state.kind === 'error' ? (
        <div className={s.trouble} role="alert" data-success="error">
          <Icon name="alert" size={12} />
          {state.message}
        </div>
      ) : null}
      {state.kind === 'draft' ? <SuccessProposalCard draft={state.draft} busy={accepting} onAccept={(p) => void handleAccept(p)} onReject={handleReject} /> : null}
    </Section>
  );
};
