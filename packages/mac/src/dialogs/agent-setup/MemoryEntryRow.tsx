import { useState } from 'react';
import type { MemoryEntry } from '@beluga/shared/memory.js';
import { IconButton } from '../../components/ui.js';
import a from './agent-setup.module.css';

type MemoryEntryRowProps = {
  readonly entry: MemoryEntry;
  readonly onSave: (entry: MemoryEntry, text: string) => Promise<boolean>;
  readonly onRemove: (entry: MemoryEntry) => void;
};

const AUTHOR_WORDS: Record<MemoryEntry['by'], string> = { you: 'You', agent: 'An agent' };

export const MemoryEntryRow = ({ entry, onSave, onRemove }: MemoryEntryRowProps) => {
  const [text, setText] = useState(entry.text);

  const handleBlur = async () => {
    if (text.trim() === entry.text) return;
    if (!(await onSave(entry, text))) setText(entry.text);
  };

  return (
    <div className={a.bar}>
      <input className={`${a.field} ${a.description}`} aria-label="Memory entry" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => void handleBlur()} />
      <span className={a.muted} title={new Date(entry.at).toLocaleString()}>
        {AUTHOR_WORDS[entry.by]}
      </span>
      <IconButton icon="trash" label="Forget This Entry" onClick={() => onRemove(entry)} />
    </div>
  );
};
