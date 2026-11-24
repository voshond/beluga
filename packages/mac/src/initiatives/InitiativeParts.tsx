import type { ReactNode } from 'react';
import { type EpicStatus, type InitiativeView, type Suggestion, openSuggestions } from '@beluga/core/initiatives/model.js';
import { Button } from '../components/ui.js';
import { progressDetail, progressPercent, progressWords } from './initiatives-model.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

export const ProgressBar = ({ progress }: { progress: EpicStatus | undefined }) => {
  const percent = progressPercent(progress);
  return (
    <span className={s.progress}>
      <span className={s.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={progressWords(progress)}>
        <span className={s.barFill} style={{ width: `${percent}%` }} />
      </span>
      <span className={s.progressLine}>
        <span>{progressWords(progress)}</span>
        {progressDetail(progress).map((part) => (
          <span key={part}>{part}</span>
        ))}
      </span>
    </span>
  );
};

export const Section = ({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) => (
  <section className={s.section} aria-label={title}>
    <div className={s.sectionHead}>
      <span>{title}</span>
      <span className={s.grow} />
      {aside}
    </div>
    {children}
  </section>
);

const SuggestionRow = ({ slug, suggestion }: { slug: string; suggestion: Suggestion }) => {
  const a = useInitiativeActions();
  const handleApprove = (): void => void a.act(() => a.api.resolveSuggestion(slug, suggestion.id, 'approve'), 'Sent to the chat');
  const handleDismiss = (): void => void a.act(() => a.api.resolveSuggestion(slug, suggestion.id, 'dismiss'));
  return (
    <div className={s.suggestion} data-suggestion={suggestion.id}>
      <span className={s.suggestionText}>
        <span>{suggestion.text}</span>
        {suggestion.why ? <span className={s.why}>{suggestion.why}</span> : null}
      </span>
      <span className={s.buttons}>
        <Button size="small" variant="primary" onClick={handleApprove} aria-label={`Approve: ${suggestion.text}`}>
          Approve
        </Button>
        <Button size="small" variant="quiet" onClick={handleDismiss} aria-label={`Dismiss: ${suggestion.text}`}>
          Dismiss
        </Button>
      </span>
    </div>
  );
};

export const Suggestions = ({ item }: { item: InitiativeView }) => {
  const open = openSuggestions(item);
  return (
    <Section title="Suggestions">
      {open.length ? (
        <div className={s.list}>
          {open.map((suggestion) => (
            <SuggestionRow key={suggestion.id} slug={item.slug} suggestion={suggestion} />
          ))}
        </div>
      ) : (
        <span className={s.quiet}>Nothing to approve. The next check-in may suggest something.</span>
      )}
    </Section>
  );
};

export const Bullets = ({ title, items, empty }: { title: string; items: readonly string[]; empty: string }) => (
  <Section title={title}>
    {items.length ? (
      <ul className={s.bullets}>
        {items.map((line, i) => (
          <li key={`${i}-${line}`}>{line}</li>
        ))}
      </ul>
    ) : (
      <span className={s.quiet}>{empty}</span>
    )}
  </Section>
);
