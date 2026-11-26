import { useState } from 'react';
import type { Artifact } from '@beluga/core/initiatives/model.js';
import { useClock } from '../lib/window-active.js';
import { ArtifactRow } from './ArtifactList.js';
import { ArtifactSheet } from './ArtifactSheet.js';
import d from './discovery.module.css';

/** Some of an initiative's artifacts in a section of its page, each opening in a sheet. */
export const ArtifactRows = ({ slug, artifacts, label }: { slug: string; artifacts: readonly Artifact[]; label: string }) => {
  const now = useClock(true, 60_000);
  const [openId, setOpenId] = useState<number | undefined>(undefined);
  const open = artifacts.find((x) => x.id === openId);
  const handleClose = (): void => setOpenId(undefined);
  if (!artifacts.length) return null;
  return (
    <>
      <div role="list" aria-label={label} className={d.proofs}>
        {artifacts.map((artifact) => (
          <ArtifactRow key={artifact.id} artifact={artifact} now={now} onOpen={setOpenId} />
        ))}
      </div>
      {open ? <ArtifactSheet slug={slug} artifact={open} close={handleClose} /> : null}
    </>
  );
};
