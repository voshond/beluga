import { useState } from 'react';
import { formatBytes } from '@beluga/shared/format.js';
import { type Artifact, type InitiativeView, sortedArtifacts } from '@beluga/core/initiatives/model.js';
import { useClock } from '../lib/window-active.js';
import { ago } from '../tasks/tasks-model.js';
import { ArtifactSheet } from './ArtifactSheet.js';
import s from './initiatives.module.css';

const whenOf = (iso: string, now: number): string => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? ago(at, now) : '';
};

export const ArtifactRow = ({ artifact, now, onOpen }: { artifact: Artifact; now: number; onOpen: (id: number) => void }) => {
  const handleClick = (): void => onOpen(artifact.id);
  const meta = [artifact.ticket, artifact.worktree, formatBytes(artifact.bytes), whenOf(artifact.createdAt, now)].filter(Boolean).join(' · ');
  return (
    <button type="button" role="listitem" className={s.logItem} onClick={handleClick} data-artifact={artifact.id} aria-label={`Open artifact ${artifact.id}: ${artifact.title}`}>
      <span className={s.logItemTop}>
        <span className={s.recordId}>#{artifact.id}</span>
        {artifact.file ? null : <span className={s.stateBadge}>Not in the repo</span>}
        <span className={s.grow} />
        <span className={s.logDate}>{meta}</span>
      </span>
      <span className={s.logItemText}>{artifact.title}</span>
      {artifact.why ? <span className={s.artifactWhy}>{artifact.why}</span> : null}
    </button>
  );
};

export const ArtifactList = ({ item }: { item: InitiativeView }) => {
  const now = useClock(true, 60_000);
  const [openId, setOpenId] = useState<number | undefined>(undefined);
  const open = item.artifacts.find((x) => x.id === openId);
  const handleClose = (): void => setOpenId(undefined);
  if (!item.artifacts.length) {
    return (
      <p className={`${s.quiet} ${s.artifactEmpty}`} role="status">
        Nothing sent yet. A worktree working on one of its tickets sends what it makes here: reports, test output, screenshots, specs.
      </p>
    );
  }
  return (
    <>
      <div role="list" aria-label={`${item.name} artifacts`} className={s.logOpen}>
        {sortedArtifacts(item.artifacts).map((artifact) => (
          <ArtifactRow key={artifact.id} artifact={artifact} now={now} onOpen={setOpenId} />
        ))}
      </div>
      {open ? <ArtifactSheet slug={item.slug} artifact={open} close={handleClose} /> : null}
    </>
  );
};
