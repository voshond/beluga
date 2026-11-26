import type { DiscoveryText } from '@beluga/core/initiatives/discovery-model.js';
import type { InitiativeView } from '@beluga/core/initiatives/model.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { DemoSection } from './DiscoveryDemo.js';
import { PromoteSection } from './DiscoveryPromote.js';
import { SizingSection } from './DiscoverySizing.js';
import { Section } from './InitiativeParts.js';
import { useDiscoveryStep } from './use-discovery.js';
import s from './initiatives.module.css';

const TextBody = ({ text, empty }: { text: DiscoveryText | undefined; empty: string }) => {
  if (!text) return <p className={s.lede}>{empty}</p>;
  return (
    <div className={s.goal}>
      <Markdown text={text.text} />
      {text.cut ? <p className={s.quiet}>Only the start is shown: the file is longer.</p> : null}
    </div>
  );
};

/** An initiative in discovery leads with what it has worked out: the problem, the evidence, its size, the PRD and the demo. */
export const DiscoverySections = ({ item }: { item: InitiativeView }) => {
  const step = useDiscoveryStep(item);
  const discovery = item.discovery ?? {};
  const handleProblem = (): void => void step({ step: 'problem' }, 'Working out the problem in the chat');
  const handlePrd = (): void => void step({ step: 'prd' }, 'Drafting the PRD in the chat');
  const handleConfluence = (): void => void step({ step: 'confluence' }, 'Your agent drafts it for Confluence: send it from the outbox');
  return (
    <>
      {discovery.trouble ? (
        <div className={s.trouble} role="alert">
          <Icon name="alert" size={13} />
          {discovery.trouble}
        </div>
      ) : null}
      <Section
        title="Problem"
        aside={
          <Button size="small" icon="chat" onClick={handleProblem}>
            Work It Out
          </Button>
        }
      >
        <TextBody text={discovery.problem} empty="Not worked out yet: Work It Out talks it through with your agent, who writes the problem and the evidence here." />
      </Section>
      <Section title="Evidence">
        <TextBody text={discovery.evidence} empty="Nothing gathered yet. Your agent adds what it finds, each point with its source." />
      </Section>
      <SizingSection item={item} />
      <Section
        title="PRD"
        aside={
          <span className={s.buttons}>
            {discovery.prd ? (
              <Button size="small" icon="send" onClick={handleConfluence}>
                Send to Confluence…
              </Button>
            ) : null}
            <Button size="small" icon="fileText" onClick={handlePrd}>
              {discovery.prd ? 'Redraft PRD' : 'Draft PRD'}
            </Button>
          </span>
        }
      >
        <TextBody text={discovery.prd} empty="No PRD yet. Draft PRD writes one from the goal, the evidence and the sizing." />
      </Section>
      <DemoSection item={item} />
      <PromoteSection item={item} />
    </>
  );
};
