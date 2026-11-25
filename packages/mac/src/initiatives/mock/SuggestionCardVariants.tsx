import { type ReactNode, useState } from 'react';
import { Button } from '../../components/ui.js';
import { ClarifyThread } from './ClarifyThread.js';
import { KIND_LABEL, MOCK_SUGGESTIONS, type MockSuggestion } from './mock-suggestions.js';
import s from './variants.module.css';

export type CardVariant = 'all' | 'inline' | 'structured' | 'focus' | 'split';

const Chips = ({ suggestion }: { suggestion: MockSuggestion }) => (
  <span className={s.chips}>
    <span className={s.kind} data-kind={suggestion.kind}>
      {KIND_LABEL[suggestion.kind]}
    </span>
    {suggestion.refs.map((ref) => (
      <span key={ref} className={s.ref}>
        {ref}
      </span>
    ))}
  </span>
);

const InlineCard = ({ suggestion }: { suggestion: MockSuggestion }) => {
  const [open, setOpen] = useState(suggestion.thread.length > 0);
  const handleToggle = (): void => setOpen((o) => !o);
  return (
    <div className={s.card}>
      <div className={s.row}>
        <span className={s.body}>
          <span>{suggestion.headline}: {suggestion.text}</span>
          <span className={s.why}>{suggestion.why}</span>
        </span>
        <span className={s.buttons}>
          <Button size="small" variant="primary">Approve</Button>
          <Button size="small" onClick={handleToggle} aria-expanded={open}>
            {open ? 'Hide' : 'Clarify'}
          </Button>
          <Button size="small" variant="quiet">Dismiss</Button>
        </span>
      </div>
      {open ? <ClarifyThread initial={suggestion.thread} /> : null}
    </div>
  );
};

const StructuredCard = ({ suggestion }: { suggestion: MockSuggestion }) => {
  const [open, setOpen] = useState(suggestion.thread.length > 0);
  const handleToggle = (): void => setOpen((o) => !o);
  return (
    <div className={s.card}>
      <Chips suggestion={suggestion} />
      <span className={s.headline}>{suggestion.headline}</span>
      <span className={s.detail}>{suggestion.text}</span>
      <span className={s.whyBox}>
        <span className={s.whyLabel}>Why</span>
        {suggestion.why}
      </span>
      {open ? <ClarifyThread initial={suggestion.thread} /> : null}
      <span className={s.footer}>
        <Button size="small" variant="quiet">Dismiss</Button>
        <span className={s.grow} />
        <Button size="small" onClick={handleToggle} aria-expanded={open}>
          {open ? 'Hide chat' : 'Clarify'}
        </Button>
        <Button size="small" variant="primary">Approve</Button>
      </span>
    </div>
  );
};

const FocusQueue = () => {
  const [index, setIndex] = useState(0);
  const [clarifying, setClarifying] = useState(false);
  const suggestion = MOCK_SUGGESTIONS[index];
  const handleNext = (): void => {
    setClarifying(false);
    setIndex((i) => (i + 1) % MOCK_SUGGESTIONS.length);
  };
  const handleClarify = (): void => setClarifying(true);
  if (!suggestion) return null;
  return (
    <div className={s.focus}>
      <span className={s.focusHead}>
        <Chips suggestion={suggestion} />
        <span className={s.grow} />
        <span className={s.counter}>
          {index + 1} of {MOCK_SUGGESTIONS.length}
        </span>
      </span>
      <span className={s.focusTitle}>{suggestion.headline}</span>
      <span className={s.detail}>{suggestion.text}</span>
      <span className={s.why}>{suggestion.why}</span>
      {clarifying ? <ClarifyThread initial={suggestion.thread} onApprove={handleNext} /> : null}
      <span className={s.footer}>
        <Button size="small" variant="quiet" onClick={handleNext}>Dismiss <kbd>D</kbd></Button>
        <Button size="small" variant="quiet" onClick={handleNext}>Skip <kbd>S</kbd></Button>
        <span className={s.grow} />
        {clarifying ? null : <Button size="small" onClick={handleClarify}>Clarify <kbd>C</kbd></Button>}
        <Button size="small" variant="primary" onClick={handleNext}>Approve <kbd>A</kbd></Button>
      </span>
    </div>
  );
};

const SplitView = () => {
  const [selectedId, setSelectedId] = useState(1);
  const selected = MOCK_SUGGESTIONS.find((m) => m.id === selectedId);
  if (!selected) return null;
  return (
    <div className={s.split}>
      <div className={s.splitList} role="listbox" aria-label="Suggestions">
        {MOCK_SUGGESTIONS.map((m) => (
          <button key={m.id} type="button" role="option" aria-selected={m.id === selectedId} className={s.splitItem} onClick={() => setSelectedId(m.id)}>
            <span className={s.kind} data-kind={m.kind}>{KIND_LABEL[m.kind]}</span>
            <span className={s.splitItemText}>{m.headline}</span>
            {m.thread.length ? <span className={s.dot} aria-label="Has a clarify chat" /> : null}
          </button>
        ))}
      </div>
      <div className={s.splitDetail}>
        <Chips suggestion={selected} />
        <span className={s.headline}>{selected.headline}</span>
        <span className={s.detail}>{selected.text}</span>
        <span className={s.why}>{selected.why}</span>
        <ClarifyThread key={selected.id} initial={selected.thread} />
        <span className={s.footer}>
          <Button size="small" variant="quiet">Dismiss</Button>
          <span className={s.grow} />
          <Button size="small" variant="primary">Approve</Button>
        </span>
      </div>
    </div>
  );
};

const Labeled = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className={s.variant}>
    <span className={s.variantTitle}>{title}</span>
    {children}
  </section>
);

const VARIANTS: Record<Exclude<CardVariant, 'all'>, { title: string; render: () => ReactNode }> = {
  inline: { title: 'A · Inline: today’s card plus Clarify', render: () => MOCK_SUGGESTIONS.map((m) => <InlineCard key={m.id} suggestion={m} />) },
  structured: { title: 'B · Structured: chips, headline, why, actions at the bottom', render: () => MOCK_SUGGESTIONS.map((m) => <StructuredCard key={m.id} suggestion={m} />) },
  focus: { title: 'C · Focus queue: one at a time, keyboard first', render: () => <FocusQueue /> },
  split: { title: 'D · Split: list on the left, detail and chat on the right', render: () => <SplitView /> },
};

const SuggestionCardVariants = ({ variant = 'all' }: { variant?: CardVariant }) => {
  const keys = variant === 'all' ? (Object.keys(VARIANTS) as Array<keyof typeof VARIANTS>) : [variant];
  return (
    <div className={s.gallery}>
      {keys.map((key) => (
        <Labeled key={key} title={VARIANTS[key].title}>
          <div className={s.list}>{VARIANTS[key].render()}</div>
        </Labeled>
      ))}
    </div>
  );
};

export default SuggestionCardVariants;
