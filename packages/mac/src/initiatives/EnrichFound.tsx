import { ENRICH_LABELS, type EnrichField, type EnrichProposal, type EnrichSource } from '@beluga/core/initiatives/enrichment.js';
import type { Person } from '@beluga/core/initiatives/people.js';
import { Button, IconButton } from '../components/ui.js';
import { useInitiativeActions } from './use-initiatives.js';
import p from './people.module.css';

const SOURCE_LABEL: Readonly<Record<EnrichSource, string>> = { slack: 'Slack', jira: 'Jira', github: 'GitHub', google: 'Google' };

const shown = (field: EnrichField, value: string | undefined): string => {
  if (!value) return '—';
  return field === 'avatar' ? 'a picture' : value;
};

type RowProps = {
  readonly person: Person;
  readonly found: EnrichProposal;
};

const FoundRow = ({ person, found }: RowProps) => {
  const a = useInitiativeActions();
  const label = ENRICH_LABELS[found.field];
  const handleKeep = (): void => void a.act(() => a.api.keepEnrichment(person.slug, found.field));
  const handleDrop = (): void => void a.act(() => a.api.dropEnrichment(person.slug, found.field));
  return (
    <li className={p.found} data-found={found.field}>
      <span className={p.foundField}>{label}</span>
      <span className={p.foundValue}>
        {person[found.field] ? <span className={p.foundWas}>{shown(found.field, person[found.field])} → </span> : null}
        {shown(found.field, found.value)}
      </span>
      <span className={p.foundWhy}>
        {SOURCE_LABEL[found.source]}
        {found.why ? ` · ${found.why}` : ''}
      </span>
      <IconButton size="small" icon="check" label={`Take ${label} for ${person.name}`} onClick={handleKeep} />
      <IconButton size="small" icon="x" label={`Dismiss ${label} for ${person.name}`} onClick={handleDrop} />
    </li>
  );
};

/** What Enrich People found for one person: each value to take or dismiss, or all at once. */
export const EnrichFound = ({ person, found }: { person: Person; found: readonly EnrichProposal[] }) => {
  const a = useInitiativeActions();
  if (!found.length) return null;
  const handleKeepAll = (): void => void a.act(() => a.api.keepEnrichment(person.slug, null), `Updated ${person.name}`);
  const handleDropAll = (): void => void a.act(() => a.api.dropEnrichment(person.slug, null));
  return (
    <div className={p.open}>
      <span className={p.openTitle}>Found · {found.length}</span>
      <ul className={p.foundList} aria-label={`Found for ${person.name}`}>
        {found.map((x) => (
          <FoundRow key={x.field} person={person} found={x} />
        ))}
      </ul>
      <span className={p.foundActions}>
        <Button size="small" onClick={handleKeepAll}>
          Take All
        </Button>
        <Button size="small" variant="quiet" onClick={handleDropAll}>
          Dismiss All
        </Button>
      </span>
    </div>
  );
};
