import { useState } from 'react';
import { INITIATIVE_STATUSES, type InitiativeStatus, type InitiativeView, initiativeOf } from '@beluga/core/initiatives/model.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, IconButton } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { sameDeep } from '../lib/stable.js';
import { GoalSection } from './GoalRefine.js';
import { Follows } from './InitiativeFollows.js';
import { Bullets, ProgressBar, Suggestions } from './InitiativeParts.js';
import { CheckInRow, MemoryFiles, Repos } from './InitiativeSettings.js';
import { InitiativeChat } from './InitiativeChat.js';
import { NewInitiativeSheet } from './NewInitiativeSheet.js';
import { TicketsTable } from './TicketsTable.js';
import { useInitiativeActions } from './use-initiatives.js';
import home from '../sentinel/home.module.css';
import s from './initiatives.module.css';

const STATUS_LABEL: Readonly<Record<InitiativeStatus, string>> = { active: 'Active', paused: 'Paused', shipped: 'Shipped', archived: 'Archived' };

const Header = ({ item, onEdit }: { item: InitiativeView; onEdit: () => void }) => {
  const a = useInitiativeActions();
  const handleStatus = (status: InitiativeStatus): void => void a.act(() => a.update(item.slug, { status }));
  const handleArchive = (): void =>
    openSheet({
      kind: 'confirm',
      title: `Archive “${item.name}”?`,
      message: 'Its check-in pauses. The folder, its memory and its chats stay; set it Active again any time.',
      confirm: 'Archive',
      run: () => void a.act(() => a.api.archive(item.slug), `Archived ${item.name}`),
    });
  const statuses: ActionItem[] = INITIATIVE_STATUSES.filter((x) => x !== 'archived').map((x) => ({ label: STATUS_LABEL[x], checked: item.status === x, onSelect: () => handleStatus(x) }));
  const more: ActionItem[] = [
    { label: 'Edit…', icon: 'pencil', onSelect: onEdit },
    { label: 'Back to All Initiatives', icon: 'back', onSelect: a.openList },
    { label: 'Archive…', icon: 'archive', separate: true, disabled: item.status === 'archived', onSelect: handleArchive },
  ];
  return (
    <div className={s.head}>
      <Icon name="flag" size={18} />
      <h1 className={s.title}>{item.name}</h1>
      <ActionsDropdown items={statuses}>
        <Button size="small" variant="quiet" aria-label={`Status: ${STATUS_LABEL[item.status]}`}>
          {STATUS_LABEL[item.status]}
        </Button>
      </ActionsDropdown>
      <span className={s.grow} />
      <Button size="small" icon="pencil" onClick={onEdit}>
        Edit…
      </Button>
      <ActionsDropdown items={more}>
        <IconButton size="small" icon="more" label={`More for ${item.name}`} />
      </ActionsDropdown>
    </div>
  );
};

const Facts = ({ item }: { item: InitiativeView }) => {
  const facts = [item.epics.length ? `Epics: ${item.epics.join(', ')}` : '', item.docs.length ? `${item.docs.length} ${item.docs.length === 1 ? 'doc' : 'docs'}` : ''].filter(Boolean);
  if (!facts.length) return null;
  return (
    <div className={s.facts}>
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </div>
  );
};

export const InitiativePage = ({ slug }: { slug: string }) => {
  const item = useApp((st) => initiativeOf(st.initiatives, slug), sameDeep);
  const enabled = useApp((st) => st.initiatives.enabled);
  const [editing, setEditing] = useState(false);
  const handleEdit = (): void => setEditing(true);
  const handleClose = (): void => setEditing(false);
  if (!enabled) return <Empty icon="flag" title="Initiatives need the Beluga app" detail="Open the Beluga app to drive one." />;
  if (!item) return <Empty icon="flag" title="That initiative is gone" detail="Its folder is no longer in the initiatives repo." />;
  return (
    <div className={home.home} data-initiative-page={item.slug}>
      <div className={home.page}>
        <div className={s.wrap}>
          <Header item={item} onEdit={handleEdit} />
          {item.trouble ? (
            <div className={s.trouble} role="alert">
              <Icon name="alert" size={13} />
              {item.trouble}
            </div>
          ) : null}
          <GoalSection item={item} />
          <div className={s.section}>
            <ProgressBar progress={item.progress} />
            <Facts item={item} />
          </div>
          <TicketsTable item={item} />
          <CheckInRow item={item} />
          <Suggestions item={item} />
          <Bullets title="Open decisions" items={item.openDecisions} empty="Nothing open in decisions.md." />
          <Bullets title="Recent" items={item.recent} empty="Nothing in timeline.md yet." />
          <Follows item={item} />
          <Repos item={item} />
          <MemoryFiles item={item} />
        </div>
      </div>
      <InitiativeChat item={item} />
      {editing ? <NewInitiativeSheet editing={item} close={handleClose} /> : null}
    </div>
  );
};
