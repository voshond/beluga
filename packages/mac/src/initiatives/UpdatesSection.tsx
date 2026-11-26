import { useState } from 'react';
import type { Audience } from '@beluga/core/initiatives/audience.js';
import type { InitiativeView } from '@beluga/core/initiatives/model.js';
import { audienceTargetWords, isUpdateDue, lastUpdateOf, nextDueOf, pendingUpdateOf } from '@beluga/core/initiatives/updates.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Button, IconButton } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import { useClock } from '../lib/window-active.js';
import { AudienceSheet } from './AudienceSheet.js';
import { Section } from './InitiativeParts.js';
import { OutboxCard } from './OutboxCards.js';
import { usePeople } from './PeopleParts.js';
import { useInitiativeActions } from './use-initiatives.js';
import p from './people.module.css';
import s from './initiatives.module.css';

const TARGET_ICON: Readonly<Record<Audience['target']['kind'], IconName>> = { slack: 'chat', confluence: 'fileText', prep: 'calendar' };

const TONE_WORDS: Readonly<Record<Audience['tone'], string>> = { short: 'Short', detailed: 'Detailed' };

const whenWords = (at: number): string => new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

type RowProps = {
  readonly item: InitiativeView;
  readonly audience: Audience;
  readonly now: number;
  readonly onEdit: (audience: Audience) => void;
};

const AudienceRow = ({ item, audience, now, onEdit }: RowProps) => {
  const a = useInitiativeActions();
  const people = usePeople();
  const last = lastUpdateOf(item, audience.id);
  const next = nextDueOf(item, audience, now);
  const pending = pendingUpdateOf(item, audience.id);
  const due = isUpdateDue(item, audience, now);
  const names = audience.people.map((slug) => people.find((x) => x.slug === slug)?.name ?? slug);
  const prep = audience.target.kind === 'prep';
  const handleEdit = (): void => onEdit(audience);
  const handleDraft = (): void => void a.act(() => a.api.draftUpdate(item.slug, audience.id), 'Drafting it: the draft shows here').then((done) => done && a.open(item, 'checkin'));
  const handleRemove = (): void =>
    openSheet({
      kind: 'confirm',
      title: `Remove the ${audience.name} audience?`,
      message: 'No more updates are drafted for it. The updates sent to it stay in the initiative’s folder.',
      confirm: 'Remove',
      run: () => void a.act(() => a.api.removeAudience(item.slug, audience.id)),
    });
  const nextWords = next === undefined ? 'On request' : next <= now ? 'Due now' : `Next due ${whenWords(next)}`;
  return (
    <div role="listitem" className={p.person} data-audience={audience.id} data-due={due || undefined}>
      <span className={p.personHead}>
        <Icon name={TARGET_ICON[audience.target.kind]} size={13} />
        <span className={p.personName}>{audience.name}</span>
        <span className={s.pill}>{TONE_WORDS[audience.tone]}</span>
        {due ? <span className={s.pill} data-tone="open">Due</span> : null}
        <span className={s.grow} />
        {pending ? null : (
          <Button size="small" icon="wand" onClick={handleDraft}>
            Draft Now
          </Button>
        )}
        <IconButton size="small" icon="pencil" label={`Edit ${audience.name}`} onClick={handleEdit} />
        <IconButton size="small" icon="x" label={`Remove ${audience.name}`} onClick={handleRemove} />
      </span>
      <span className={p.meta}>
        <span>{audienceTargetWords(audience.target)}</span>
        {names.length ? <span>For {names.join(', ')}</span> : null}
      </span>
      <span className={p.meta}>
        <span>{last ? `${prep ? 'Last kept' : 'Last sent'} ${whenWords(Date.parse(last.at))}` : prep ? 'No prep sheet yet' : 'Nothing sent yet'}</span>
        <span>{nextWords}</span>
      </span>
      {pending ? <OutboxCard key={pending.id} item={item} draft={pending} /> : null}
    </div>
  );
};

type Editing = { readonly audience?: Audience };

/** Stakeholder updates: one row per audience with when it was last sent and when the next is due, and its draft when one waits. */
export const UpdatesSection = ({ item }: { item: InitiativeView }) => {
  const now = useClock(true, 60_000);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const audiences = item.audiences ?? [];
  const handleNew = (): void => setEditing({});
  const handleEdit = (audience: Audience): void => setEditing({ audience });
  const handleClose = (): void => setEditing(undefined);
  return (
    <Section title="Updates" aside={<IconButton size="small" icon="plus" label="New audience" onClick={handleNew} />}>
      {audiences.length ? (
        <div className={p.people} role="list" aria-label="Audiences">
          {audiences.map((audience) => (
            <AudienceRow key={audience.id} item={item} audience={audience} now={now} onEdit={handleEdit} />
          ))}
        </div>
      ) : (
        <span className={s.quiet} role="status">
          No audiences yet. Add one, and your agent drafts its status updates on its schedule for you to send.
        </span>
      )}
      {editing ? <AudienceSheet item={item} {...(editing.audience ? { audience: editing.audience } : {})} close={handleClose} /> : null}
    </Section>
  );
};
