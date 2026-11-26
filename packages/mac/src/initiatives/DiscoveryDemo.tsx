import { useState } from 'react';
import { type DemoState, artifactsAbout } from '@beluga/core/initiatives/discovery-model.js';
import type { InitiativeView } from '@beluga/core/initiatives/model.js';
import { Popup } from '../components/FormSheet.js';
import { Button } from '../components/ui.js';
import { ArtifactRows } from './ArtifactRows.js';
import { Section } from './InitiativeParts.js';
import { useDiscoveryStep } from './use-discovery.js';
import d from './discovery.module.css';
import s from './initiatives.module.css';

const STATE_LABEL: Readonly<Record<DemoState, string>> = { drafted: 'Waiting for your go', started: 'Being built', done: 'Done' };

const DemoLine = ({ item }: { item: InitiativeView }) => {
  const demo = item.discovery?.demo;
  if (!demo) {
    const empty = item.repos.length ? 'No demo yet. Start Demo writes a brief from the goal and opens a task in the repo; it starts only when you say so.' : 'Link the product’s repo first (Repos, below): the demo is built there by a normal task.';
    return <p className={s.lede}>{empty}</p>;
  }
  return (
    <div className={d.demo} data-demo={demo.task ?? ''}>
      <span>{demo.title ?? 'Demo'}</span>
      {demo.task ? <span className={s.pill}>{demo.task}</span> : null}
      {demo.repo ? <span className={s.quiet}>in {demo.repo}</span> : null}
      <span className={s.stateBadge} data-state={demo.state === 'drafted' ? 'open' : 'approved'}>
        {STATE_LABEL[demo.state]}
      </span>
    </div>
  );
};

export const DemoSection = ({ item }: { item: InitiativeView }) => {
  const step = useDiscoveryStep(item);
  const [picked, setPicked] = useState(item.repos[0] ?? '');
  const repo = item.repos.includes(picked) ? picked : (item.repos[0] ?? '');
  const proofs = artifactsAbout(item.artifacts, 'demo');
  const handleStart = (): void => void step({ step: 'demo', repo }, `Writing the demo’s brief for ${repo} in the chat`);
  const aside = repo ? (
    <span className={s.buttons}>
      {item.repos.length > 1 ? <Popup value={repo} options={item.repos.map((r) => ({ value: r, label: r }))} onChange={setPicked} label="Demo repo" /> : null}
      <Button size="small" icon="plus" onClick={handleStart}>
        {item.discovery?.demo ? 'New Demo' : 'Start Demo'}
      </Button>
    </span>
  ) : undefined;
  return (
    <Section title="Demo" aside={aside}>
      <DemoLine item={item} />
      <ArtifactRows slug={item.slug} artifacts={proofs} label="Demo proof" />
    </Section>
  );
};
