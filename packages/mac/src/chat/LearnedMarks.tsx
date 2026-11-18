import { useState } from 'react';
import type { LogItem } from '@beluga/core/store.js';
import { type LearnedMark, type MemoryMark, type RecallMark, type SkillMark, learnedScope, learnedTitle } from '@beluga/shared/learned.js';
import { changedEntry } from '@beluga/shared/memory.js';
import { Icon } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { toast, useApp, useBeluga } from '../lib/beluga.js';
import l from './learned.module.css';

type AgentItem = Extract<LogItem, { type: 'agent' }>;

/**
 * Under your agent's answer (BLG-102): what its run remembered, proposed or looked up, one soft
 * chip each, kept on its card so they show again after a reload. A memory write has Undo; a
 * proposed skill opens its Keep / Discard card in Needs You; a search says what it looked for.
 */
export function LearnedMarks({ item }: { item: AgentItem }) {
  const marks = item.learned;
  if (!marks?.length) return null;
  return (
    <div className={l.row} role="group" aria-label="What it remembered, proposed or looked up">
      {marks.map((mark) => (
        <LearnedChip key={mark.id} item={item} mark={mark} />
      ))}
    </div>
  );
}

function LearnedChip({ item, mark }: { item: AgentItem; mark: LearnedMark }) {
  if (mark.kind === 'memory') return <MemoryChip item={item} mark={mark} />;
  if (mark.kind === 'skill') return <SkillChip mark={mark} />;
  return <RecallChip mark={mark} />;
}

function MemoryChip({ item, mark }: { item: AgentItem; mark: MemoryMark }) {
  const { client } = useBeluga();
  const [busy, setBusy] = useState(false);
  const entry = changedEntry(mark.change);
  const undone = mark.undone !== undefined;
  const scope = learnedScope(mark);
  const handleUndo = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.api.memory.undo(item.channel, item.id, mark.id);
      toast(client, mark.change.op === 'add' ? 'Forgot it again' : 'Put the memory back as it was');
    } catch (err) {
      toast(client, err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const was = mark.change.op === 'replace' && mark.change.before ? ` (was: “${mark.change.before.text}”)` : '';
  return (
    <span className={cx(l.chip, l.memory, undone && l.undone)} data-testid="learned-memory" data-op={mark.change.op}>
      <Tip label={`${learnedTitle(mark)} · ${scope}: “${entry.text}”${was}${undone ? ' · Undone' : ''}`}>
        <span className={l.main}>
          <Icon name={mark.change.op === 'remove' ? 'eraser' : 'bulb'} size={11} />
          <span className={l.what}>{learnedTitle(mark)}</span>
          <span className={l.text}>{entry.text}</span>
          <span className={l.scope}>{scope}</span>
        </span>
      </Tip>
      {undone ? (
        <span className={l.state}>Undone</span>
      ) : (
        <button type="button" className={l.action} disabled={busy} onClick={() => void handleUndo()} aria-label={`Undo: ${learnedTitle(mark)} “${entry.text}”`}>
          Undo
        </button>
      )}
    </span>
  );
}

function SkillChip({ mark }: { mark: SkillMark }) {
  const { ui } = useBeluga();
  const waiting = useApp((st) => st.skillProposals.some((p) => p.id === mark.proposal));
  const handleOpen = (): void => ui.patch({ notices: true });
  return (
    <Tip label={waiting ? 'Waits for you in Needs You: click to Keep or Discard it' : 'Answered: kept or discarded'}>
      <button type="button" className={cx(l.chip, l.skill)} data-testid="learned-skill" disabled={!waiting} onClick={handleOpen}>
        <span className={l.main}>
          <Icon name="sparkles" size={11} />
          <span className={l.what}>{learnedTitle(mark)}</span>
        </span>
        <span className={l.state}>{waiting ? (mark.update ? 'Update / Discard' : 'Keep / Discard') : 'Answered'}</span>
      </button>
    </Tip>
  );
}

function RecallChip({ mark }: { mark: RecallMark }) {
  return (
    <Tip label={learnedTitle(mark)}>
      <span className={cx(l.chip, l.recall)} data-testid="learned-recall">
        <span className={l.main}>
          <Icon name="search" size={11} />
          <span className={l.what}>Searched past chats for</span>
          <span className={l.text}>“{mark.query}”</span>
        </span>
      </span>
    </Tip>
  );
}
