import { useState } from 'react';
import { Button } from '../../components/ui.js';
import { KIND_LABEL, type MockSuggestion, PROOF_LABEL, STATE_LABEL } from './mock-suggestions.js';
import s from './variants.module.css';

type ItemProps = { readonly suggestion: MockSuggestion };

export const KindChip = ({ suggestion }: ItemProps) => (
  <span className={s.kind} data-kind={suggestion.kind}>
    {KIND_LABEL[suggestion.kind]}
  </span>
);

export const StateBadge = ({ suggestion }: ItemProps) => (
  <span className={s.state} data-state={suggestion.state}>
    {STATE_LABEL[suggestion.state]}
  </span>
);

export const Refs = ({ suggestion }: ItemProps) => (
  <span className={s.chips}>
    <KindChip suggestion={suggestion} />
    {suggestion.refs.map((ref) => (
      <span key={ref} className={s.ref}>
        {ref}
      </span>
    ))}
  </span>
);

export const ProofList = ({ suggestion }: ItemProps) => {
  if (!suggestion.proof.length) return <span className={s.quiet}>No proof attached.</span>;
  return (
    <span className={s.proofs}>
      {suggestion.proof.map((p) => (
        <a key={p.label} className={s.proof} href={p.url} data-proof={p.kind}>
          <span className={s.proofKind}>{PROOF_LABEL[p.kind]}</span>
          {p.label}
        </a>
      ))}
    </span>
  );
};

export const OpenActions = ({ suggestion }: ItemProps) => {
  const [sent, setSent] = useState(Boolean(suggestion.inChat));
  const handleClarify = (): void => setSent(true);
  return (
    <span className={s.footer}>
      <Button size="small" variant="quiet">Dismiss</Button>
      <span className={s.grow} />
      <Button size="small" onClick={handleClarify} aria-label={`Clarify in chat: ${suggestion.headline}`}>
        {sent ? 'Open in chat ↗' : 'Clarify in chat'}
      </Button>
      <Button size="small" variant="primary">{suggestion.kind === 'decision' ? 'Decide…' : 'Approve'}</Button>
    </span>
  );
};

export const ListItem = ({ suggestion, selected, onSelect }: ItemProps & { readonly selected: boolean; readonly onSelect: (id: number) => void }) => {
  const handleClick = (): void => onSelect(suggestion.id);
  return (
    <button type="button" role="option" aria-selected={selected} className={s.item} onClick={handleClick}>
      <span className={s.itemTop}>
        <KindChip suggestion={suggestion} />
        {suggestion.state === 'open' ? null : <StateBadge suggestion={suggestion} />}
        {suggestion.inChat ? <span className={s.inChat}>In chat</span> : null}
        <span className={s.grow} />
        <span className={s.itemDate}>{(suggestion.resolvedAt ?? suggestion.createdAt).slice(5, 10)}</span>
      </span>
      <span className={s.itemText}>{suggestion.headline}</span>
    </button>
  );
};

export const CompactDetail = ({ suggestion }: ItemProps) => (
  <div className={s.detailPane}>
    <Refs suggestion={suggestion} />
    <span className={s.headline}>{suggestion.headline}</span>
    <span className={s.detail}>{suggestion.text}</span>
    <span className={s.why}>{suggestion.why}</span>
    {suggestion.state === 'open' ? (
      <OpenActions suggestion={suggestion} />
    ) : (
      <>
        <span className={s.outcome}>
          <StateBadge suggestion={suggestion} />
          {suggestion.answer ? <strong>{suggestion.answer}</strong> : null}
          <span>{suggestion.outcome}</span>
        </span>
        <ProofList suggestion={suggestion} />
      </>
    )}
  </div>
);

export const Timeline = ({ suggestion }: ItemProps) => (
  <ol className={s.timeline}>
    {suggestion.timeline.map((e) => (
      <li key={`${e.at}-${e.text}`} className={s.event}>
        <span className={s.eventAt}>{e.at}</span>
        <span>{e.text}</span>
      </li>
    ))}
  </ol>
);

export const TimelineDetail = ({ suggestion }: ItemProps) => (
  <div className={s.detailPane}>
    <span className={s.detailHead}>
      <Refs suggestion={suggestion} />
      <span className={s.grow} />
      <StateBadge suggestion={suggestion} />
    </span>
    <span className={s.headline}>{suggestion.headline}</span>
    <span className={s.detail}>{suggestion.text}</span>
    <span className={s.why}>{suggestion.why}</span>
    {suggestion.answer ? <span className={s.answer}>Decided: {suggestion.answer}</span> : null}
    <span className={s.label}>History</span>
    <Timeline suggestion={suggestion} />
    <span className={s.label}>Proof</span>
    <ProofList suggestion={suggestion} />
    {suggestion.state === 'open' ? <OpenActions suggestion={suggestion} /> : null}
  </div>
);

export const RecordDetail = ({ suggestion }: ItemProps) => (
  <article className={s.record}>
    <span className={s.detailHead}>
      <span className={s.recordId}>#{suggestion.id}</span>
      <StateBadge suggestion={suggestion} />
      <span className={s.grow} />
      <Button size="small" variant="quiet">Copy as Markdown</Button>
    </span>
    <h3 className={s.recordTitle}>{suggestion.headline}</h3>
    <Refs suggestion={suggestion} />
    <span className={s.label}>Context</span>
    <p className={s.recordText}>{suggestion.why}</p>
    <span className={s.label}>Suggestion</span>
    <p className={s.recordText}>{suggestion.text}</p>
    <span className={s.label}>Decision</span>
    <p className={s.recordText}>{suggestion.answer ?? (suggestion.state === 'open' ? 'Not decided yet.' : STATE_LABEL[suggestion.state])}</p>
    <span className={s.label}>Outcome</span>
    <p className={s.recordText}>{suggestion.outcome ?? '—'}</p>
    <span className={s.label}>Proof</span>
    <ProofList suggestion={suggestion} />
    {suggestion.state === 'open' ? <OpenActions suggestion={suggestion} /> : null}
  </article>
);
