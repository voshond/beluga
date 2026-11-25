import { type KeyboardEvent, useState } from 'react';
import { TextInput } from '../../components/FormSheet.js';
import { Button } from '../../components/ui.js';
import { type ClarifyMessage, MOCK_AGENT_REPLY } from './mock-suggestions.js';
import s from './variants.module.css';

type ClarifyThreadProps = {
  readonly initial: readonly ClarifyMessage[];
  readonly onApprove?: () => void;
};

export const ClarifyThread = ({ initial, onApprove }: ClarifyThreadProps) => {
  const [messages, setMessages] = useState<readonly ClarifyMessage[]>(initial);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);

  const handleSend = (): void => {
    const text = draft.trim();
    if (!text) return;
    setMessages((m) => [...m, { from: 'me', text }]);
    setDraft('');
    setThinking(true);
    setTimeout(() => {
      setMessages((m) => [...m, { from: 'agent', text: MOCK_AGENT_REPLY }]);
      setThinking(false);
    }, 900);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    handleSend();
  };

  return (
    <div className={s.thread} aria-label="Clarify with the agent">
      {messages.length ? (
        <div className={s.messages}>
          {messages.map((m, i) => (
            <div key={`${i}-${m.from}`} className={s.message} data-from={m.from}>
              <span className={s.author}>{m.from === 'me' ? 'You' : 'Claude'}</span>
              <span>{m.text}</span>
            </div>
          ))}
          {thinking ? <div className={s.thinking}>Claude is thinking…</div> : null}
        </div>
      ) : (
        <span className={s.hint}>Ask anything about this suggestion. Nothing is sent or changed until you approve.</span>
      )}
      <div className={s.threadInput}>
        <TextInput className={s.grow} value={draft} onChange={setDraft} onKeyDown={handleKeyDown} placeholder="Ask about this suggestion…" aria-label="Ask about this suggestion" />
        <Button size="small" onClick={handleSend} disabled={!draft.trim()}>
          Ask
        </Button>
        {onApprove ? (
          <Button size="small" variant="primary" onClick={onApprove}>
            Approve
          </Button>
        ) : null}
      </div>
    </div>
  );
};
