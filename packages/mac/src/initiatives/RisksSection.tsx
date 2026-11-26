import { useState } from 'react';
import { type InitiativeView } from '@beluga/core/initiatives/model.js';
import { type Risk, type RiskSeverity, type RiskState, closedRisks, openRisks } from '@beluga/core/initiatives/risks.js';
import { Button, IconButton } from '../components/ui.js';
import { openExternal } from '../lib/system.js';
import { TonePill } from '../plans/marks.js';
import type { Tone } from '../plans/plans-model.js';
import { Section } from './InitiativeParts.js';
import { RISK_STATE_LABEL, RiskSheet, SEVERITY_LABEL } from './RiskSheet.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

const SEVERITY_TONE: Readonly<Record<RiskSeverity, Tone>> = { high: 'error', medium: 'warn', low: 'muted' };

const draftOf = (risk: Risk, state: RiskState) => ({ id: risk.id, title: risk.title, why: risk.why ?? '', severity: risk.severity, owner: risk.owner ?? '', mitigation: risk.mitigation ?? '', state });

type RiskRowProps = { readonly slug: string; readonly risk: Risk; readonly onEdit: (risk: Risk) => void };

const RiskRow = ({ slug, risk, onEdit }: RiskRowProps) => {
  const a = useInitiativeActions();
  const closed = risk.state === 'closed';
  const handleEdit = (): void => onEdit(risk);
  const handleState = (): void => void a.act(() => a.api.saveRisk(slug, draftOf(risk, closed ? 'open' : 'closed')), closed ? `Reopened risk ${risk.id}` : `Closed risk ${risk.id}`);
  const meta = [
    { label: 'Owner', text: risk.owner },
    { label: 'Mitigation', text: risk.mitigation },
  ].filter((line) => line.text);
  const links = risk.sources.filter((source) => source.url);
  return (
    <div role="listitem" className={s.risk} data-risk={risk.id} data-severity={risk.severity} data-state={risk.state}>
      <span className={s.riskHead}>
        <TonePill tone={closed ? 'muted' : SEVERITY_TONE[risk.severity]}>{SEVERITY_LABEL[risk.severity]}</TonePill>
        <span className={s.riskTitle}>{risk.title}</span>
        <span className={s.riskEnd}>
          {risk.state === 'watching' ? <TonePill tone="info">{RISK_STATE_LABEL.watching}</TonePill> : null}
          {risk.owned ? (
            <span className={s.riskOwned} title="You edited it on the page: the check-ins keep your edit">
              Edited by you
            </span>
          ) : null}
          <IconButton size="small" icon="pencil" label={`Edit risk ${risk.id}`} onClick={handleEdit} />
          <IconButton size="small" icon={closed ? 'refresh' : 'check'} label={`${closed ? 'Reopen' : 'Close'} risk ${risk.id}`} onClick={handleState} />
        </span>
      </span>
      {risk.why ? <span className={s.riskLine}>{risk.why}</span> : null}
      {meta.map((line) => (
        <span key={line.label} className={s.riskLine}>
          <span className={s.riskLabel}>{line.label}</span> {line.text}
        </span>
      ))}
      {links.length ? (
        <span className={s.riskLinks}>
          {links.map((source) => (
            <button key={source.label} type="button" className={s.proofLink} onClick={() => void openExternal(source.url ?? '')} aria-label={`Open ${source.label}`}>
              {source.label}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
};

const RiskList = ({ slug, risks, name, onEdit }: { slug: string; risks: readonly Risk[]; name: string; onEdit: (risk: Risk) => void }) => (
  <div className={s.ticketList} role="list" aria-label={name}>
    {risks.map((risk) => (
      <RiskRow key={risk.id} slug={slug} risk={risk} onEdit={onEdit} />
    ))}
  </div>
);

/** What could sink it: open and watched risks by severity, closed ones behind Show Closed. */
export const RisksSection = ({ item }: { item: InitiativeView }) => {
  const [editing, setEditing] = useState<Risk | 'new' | undefined>(undefined);
  const [showClosed, setShowClosed] = useState(false);
  const open = openRisks(item.risks ?? []);
  const closed = closedRisks(item.risks ?? []);
  const handleAdd = (): void => setEditing('new');
  const handleEdit = (risk: Risk): void => setEditing(risk);
  const handleCloseSheet = (): void => setEditing(undefined);
  const handleToggleClosed = (): void => setShowClosed((was) => !was);
  const aside = (
    <Button size="small" icon="plus" onClick={handleAdd}>
      Add Risk
    </Button>
  );
  return (
    <Section title="Risks" aside={aside}>
      {open.length ? (
        <RiskList slug={item.slug} risks={open} name="Open risks" onEdit={handleEdit} />
      ) : (
        <span className={s.quiet} role="status">
          {closed.length ? 'No open risks.' : 'No risks yet. The check-in keeps a short list of what could sink it, and you can add one any time.'}
        </span>
      )}
      {closed.length ? (
        <div>
          <Button size="small" variant="quiet" onClick={handleToggleClosed} aria-expanded={showClosed}>
            {showClosed ? 'Hide Closed' : `Show Closed · ${closed.length}`}
          </Button>
        </div>
      ) : null}
      {showClosed && closed.length ? <RiskList slug={item.slug} risks={closed} name="Closed risks" onEdit={handleEdit} /> : null}
      {editing ? <RiskSheet slug={item.slug} {...(editing === 'new' ? {} : { risk: editing })} close={handleCloseSheet} /> : null}
    </Section>
  );
};
