import { type KeyboardEvent, useState } from 'react';
import { artifactsAbout } from '@beluga/core/initiatives/discovery-model.js';
import type { InitiativeView } from '@beluga/core/initiatives/model.js';
import { TextInput } from '../components/FormSheet.js';
import { Button } from '../components/ui.js';
import { ArtifactRows } from './ArtifactRows.js';
import { Section } from './InitiativeParts.js';
import { useDiscoveryStep } from './use-discovery.js';
import d from './discovery.module.css';
import s from './initiatives.module.css';

export const SizingSection = ({ item }: { item: InitiativeView }) => {
  const step = useDiscoveryStep(item);
  const [question, setQuestion] = useState('');
  const findings = artifactsAbout(item.artifacts, 'sizing');
  const asked = question.trim();
  const handleSize = (): void => {
    if (!asked) return;
    void step({ step: 'size', question: asked }, 'Sizing it from BigQuery in the chat').then((sent) => sent && setQuestion(''));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') handleSize();
  };
  return (
    <Section title="Sizing">
      <div className={d.ask}>
        <TextInput value={question} onChange={setQuestion} onKeyDown={handleKeyDown} maxLength={1000} placeholder="How many orders ask for a return by email?" aria-label="Sizing question" />
        <Button size="small" icon="chartBar" onClick={handleSize} disabled={!asked}>
          Size It
        </Button>
      </div>
      {findings.length ? (
        <ArtifactRows slug={item.slug} artifacts={findings} label="Sizing findings" />
      ) : (
        <p className={s.quiet}>Ask how big the problem is: your agent answers from BigQuery and keeps the finding with its query.</p>
      )}
    </Section>
  );
};
