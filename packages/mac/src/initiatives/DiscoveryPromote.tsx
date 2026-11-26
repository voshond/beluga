import { type ProposedEpic, proposedEpicKeys } from '@beluga/core/initiatives/discovery-model.js';
import type { InitiativeView } from '@beluga/core/initiatives/model.js';
import { Button } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import { Section } from './InitiativeParts.js';
import { useDiscoveryStep } from './use-discovery.js';
import { useInitiativeActions } from './use-initiatives.js';
import d from './discovery.module.css';
import s from './initiatives.module.css';

const EpicCard = ({ epic }: { epic: ProposedEpic }) => (
  <li className={d.epic} data-proposed-epic={epic.key ?? ''}>
    <span className={d.epicHead}>
      <span className={s.pill} data-tone={epic.key ? 'open' : undefined}>
        {epic.key ?? 'Not in Jira yet'}
      </span>
      <span>{epic.title}</span>
    </span>
    {epic.why ? <span className={s.why}>{epic.why}</span> : null}
    {epic.stories.length ? (
      <ul className={d.stories}>
        {epic.stories.map((story) => (
          <li key={`${story.key ?? ''}${story.title}`}>{story.key ? `${story.key} · ${story.title}` : story.title}</li>
        ))}
      </ul>
    ) : null}
  </li>
);

export const PromoteSection = ({ item }: { item: InitiativeView }) => {
  const a = useInitiativeActions();
  const step = useDiscoveryStep(item);
  const proposal = item.discovery?.proposal;
  const keys = proposedEpicKeys(proposal);
  const handlePropose = (): void => void step({ step: 'propose' }, 'Proposing the epics and stories in the chat');
  const handlePromote = (): void =>
    openSheet({
      kind: 'confirm',
      title: `Move “${item.name}” to delivery?`,
      message: `It becomes active with ${keys.join(', ')} linked, and its tickets are read from Jira. What discovery found stays in its memory.`,
      confirm: 'Move to Delivery',
      run: () => void a.act(() => a.api.promote(item.slug), `${item.name} is in delivery`),
    });
  const aside = (
    <span className={s.buttons}>
      <Button size="small" icon="bulb" onClick={handlePropose}>
        {proposal?.epics.length ? 'Propose Again' : 'Propose Epics'}
      </Button>
      <Button size="small" variant="primary" icon="flag" onClick={handlePromote} disabled={!keys.length}>
        Move to Delivery
      </Button>
    </span>
  );
  return (
    <Section title="Delivery" aside={aside}>
      {proposal?.epics.length ? (
        <ul className={d.epics} aria-label="Proposed epics">
          {proposal.epics.map((epic) => (
            <EpicCard key={`${epic.key ?? ''}${epic.title}`} epic={epic} />
          ))}
        </ul>
      ) : (
        <p className={s.lede}>When it is ready, your agent proposes the epics and stories. Nothing is created in Jira until you approve it; then Move to Delivery links the epics.</p>
      )}
    </Section>
  );
};
