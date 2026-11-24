import { type KeyboardEvent, useState } from 'react';
import type { Suggestion } from '@beluga/core/initiatives/model.js';
import { TextInput } from '../components/FormSheet.js';
import { Button } from '../components/ui.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

/** A suggestion that is the user's call: its answers as buttons, Other… for one of their own, then it goes to the chat. */
export const DecisionRow = ({ slug, suggestion }: { slug: string; suggestion: Suggestion }) => {
  const a = useInitiativeActions();
  const [other, setOther] = useState<string | undefined>(undefined);
  const handleDecide = (answer: string): void => void a.act(() => a.api.resolveSuggestion(slug, suggestion.id, 'approve', answer), 'Decided: sent to the chat');
  const handleDismiss = (): void => void a.act(() => a.api.resolveSuggestion(slug, suggestion.id, 'dismiss'));
  const handleOther = (): void => setOther('');
  const handleCancel = (): void => setOther(undefined);
  const handleSubmit = (): void => {
    if (!other?.trim()) return;
    handleDecide(other.trim());
  };
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') handleCancel();
  };
  return (
    <div className={s.suggestion} data-suggestion={suggestion.id} data-decision>
      <span className={s.suggestionText}>
        <span>{suggestion.text}</span>
        {suggestion.why ? <span className={s.why}>{suggestion.why}</span> : null}
        {other === undefined ? (
          <span className={s.answers} role="group" aria-label={`Decide: ${suggestion.text}`}>
            {(suggestion.options ?? []).map((option) => (
              <Button key={option} size="small" onClick={() => handleDecide(option)} aria-label={`Decide ${option}: ${suggestion.text}`}>
                {option}
              </Button>
            ))}
            <Button size="small" variant={suggestion.options?.length ? 'quiet' : 'plain'} onClick={handleOther}>
              {suggestion.options?.length ? 'Other…' : 'Decide…'}
            </Button>
            <span className={s.grow} />
            <Button size="small" variant="quiet" onClick={handleDismiss} aria-label={`Dismiss: ${suggestion.text}`}>
              Dismiss
            </Button>
          </span>
        ) : (
          <span className={s.answers}>
            <TextInput className={s.answerInput} value={other} onChange={setOther} onKeyDown={handleKeyDown} maxLength={2000} placeholder="Your decision" aria-label={`Your decision: ${suggestion.text}`} autoFocus />
            <Button size="small" variant="primary" onClick={handleSubmit} disabled={!other.trim()}>
              Decide
            </Button>
            <Button size="small" variant="quiet" onClick={handleCancel}>
              Cancel
            </Button>
          </span>
        )}
      </span>
    </div>
  );
};
