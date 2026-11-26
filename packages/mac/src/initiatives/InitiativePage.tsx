import { useState } from 'react';
import { INITIATIVE_STATUSES, type InitiativeStatus, type InitiativeView, initiativeOf } from '@beluga/core/initiatives/model.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, IconButton } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { sameDeep } from '../lib/stable.js';
import { DiscoverySections } from './DiscoverySections.js';
import { GoalSection } from './GoalRefine.js';
import { Follows } from './InitiativeFollows.js';
import { EpicLink, ProgressBar } from './InitiativeParts.js';
import { Timeline } from './InitiativeTimeline.js';
import { CheckInRow, MemoryFiles, Repos } from './InitiativeSettings.js';
import { InitiativePanel, type PanelTab } from './InitiativePanel.js';
import { NewInitiativeSheet } from './NewInitiativeSheet.js';
import { PeopleSection } from './PeopleSection.js';
import { RisksSection } from './RisksSection.js';
import { Suggestions } from './SuggestionLog.js';
import { SuccessSection } from './SuccessSection.js';
import { TasksSection } from './TasksSection.js';
import { TicketsTable } from './TicketsTable.js';
import { UpdatesSection } from './UpdatesSection.js';
import { useInitiativeActions } from './use-initiatives.js';
import { WatchesSection } from './WatchesSection.js';
import home from '../sentinel/home.module.css';
import s from './initiatives.module.css';

const STATUS_LABEL: Readonly<Record<InitiativeStatus, string>> = { discovery: 'Discovery', active: 'Active', paused: 'Paused', shipped: 'Shipped', archived: 'Archived' };

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
  const statuses: ActionItem[] = INITIATIVE_STATUSES.filter((x) => x !== 'archived' && (x !== 'discovery' || item.status === 'discovery')).map((x) => ({ label: STATUS_LABEL[x], checked: item.status === x, onSelect: () => handleStatus(x) }));
  const more: ActionItem[] = [
    { label: 'Edit…', icon: 'pencil', onSelect: onEdit },
    { label: 'Back to All Initiatives', icon: 'back', onSelect: a.openList },
    { label: 'People Across Initiatives', icon: 'people', onSelect: a.openPeople },
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
  if (!item.epics.length) return null;
  return (
    <div className={s.facts}>
      <span>Epics:</span>
      {item.epics.map((epic) => (
        <EpicLink key={epic} epic={epic} item={item} />
      ))}
    </div>
  );
};

export const InitiativePage = ({ slug }: { slug: string }) => {
  const item = useApp((st) => initiativeOf(st.initiatives, slug), sameDeep);
  const enabled = useApp((st) => st.initiatives.enabled);
  const [editing, setEditing] = useState(false);
  const [pickedId, setPickedId] = useState<number | undefined>(undefined);
  const [tab, setTab] = useState<PanelTab>('chat');
  const handleEdit = (): void => setEditing(true);
  const handleClose = (): void => setEditing(false);
  const handlePick = (id: number): void => {
    setPickedId(id);
    setTab('record');
  };
  const handleUnpick = (): void => {
    setPickedId(undefined);
    setTab('chat');
  };
  if (!enabled) return <Empty icon="flag" title="Initiatives need the Beluga app" detail="Open the Beluga app to drive one." />;
  if (!item) return <Empty icon="flag" title="That initiative is gone" detail="Its folder is no longer in the initiatives repo." />;
  const picked = item.suggestions.find((x) => x.id === pickedId);
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
          {item.status === 'discovery' ? (
            <>
              <DiscoverySections item={item} />
              <RisksSection item={item} />
            </>
          ) : (
            <>
              <div className={s.section}>
                <ProgressBar progress={item.progress} />
                <Facts item={item} />
              </div>
              <RisksSection item={item} />
              <SuccessSection item={item} />
              <TicketsTable item={item} />
            </>
          )}
          <CheckInRow item={item} />
          <Suggestions item={item} pickedId={picked?.id} onPick={handlePick} />
          <WatchesSection item={item} />
          <UpdatesSection item={item} />
          <PeopleSection item={item} />
          <TasksSection item={item} />
          <Timeline item={item} />
          <Follows item={item} />
          <Repos item={item} />
          <MemoryFiles item={item} />
        </div>
      </div>
      <InitiativePanel item={item} picked={picked} tab={tab} onTab={setTab} onClose={handleUnpick} />
      {editing ? <NewInitiativeSheet editing={item} close={handleClose} /> : null}
    </div>
  );
};
