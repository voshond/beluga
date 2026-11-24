import { useState } from 'react';
import { type InitiativeView, openSuggestions } from '@beluga/core/initiatives/model.js';
import { Icon } from '../components/Icon.js';
import { Button, Empty } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { useClock } from '../lib/window-active.js';
import { ago } from '../tasks/tasks-model.js';
import { ProgressBar } from './InitiativeParts.js';
import { lastCheckInWords, sortedInitiatives } from './initiatives-model.js';
import { NewInitiativeSheet } from './NewInitiativeSheet.js';
import { useInitiativeActions } from './use-initiatives.js';
import home from '../sentinel/home.module.css';
import s from './initiatives.module.css';

const InitiativeCard = ({ item, now }: { item: InitiativeView; now: number }) => {
  const a = useInitiativeActions();
  const asks = openSuggestions(item).length;
  const handleOpen = (): void => a.open(item);
  return (
    <button type="button" className={s.card} data-status={item.status} data-initiative={item.slug} onClick={handleOpen} aria-label={`Open ${item.name}`}>
      <span className={s.cardHead}>
        <Icon name="flag" size={14} />
        <span className={s.cardName}>{item.name}</span>
        {item.status !== 'active' ? <span className={s.pill}>{item.status}</span> : null}
        <span className={s.grow} />
        {asks ? (
          <span className={s.pill} data-tone="open">
            {asks} {asks === 1 ? 'suggestion' : 'suggestions'}
          </span>
        ) : null}
      </span>
      {item.trouble ? (
        <span className={s.trouble}>
          <Icon name="alert" size={12} />
          {item.trouble}
        </span>
      ) : null}
      <ProgressBar progress={item.progress} />
      <span className={s.cardLine}>
        {item.epics.length ? <span>{item.epics.join(', ')}</span> : null}
        <span>
          {item.openDecisions.length} open {item.openDecisions.length === 1 ? 'decision' : 'decisions'}
        </span>
        <span>{lastCheckInWords(item, (at) => ago(at, now))}</span>
      </span>
    </button>
  );
};

export const InitiativesHome = () => {
  const enabled = useApp((st) => st.initiatives.enabled);
  const items = useApp((st) => sortedInitiatives(st.initiatives.items), sameDeep);
  const root = useApp((st) => st.initiatives.root);
  const now = useClock(true, 60_000);
  const [making, setMaking] = useState(false);
  const handleNew = (): void => setMaking(true);
  const handleClose = (): void => setMaking(false);
  if (!enabled) return <Empty icon="flag" title="Initiatives need the Beluga app" detail="They live in the Beluga app’s daemon: open the app to drive one." />;
  return (
    <div className={home.home}>
      <div className={home.page}>
        <div className={s.wrap}>
          <div className={s.head}>
            <h1 className={s.title}>Initiatives</h1>
            <span className={s.grow} />
            <Button variant="primary" icon="plus" onClick={handleNew}>
              New Initiative
            </Button>
          </div>
          <p className={s.lede}>Each drives one thing to ship: its Jira epics, Slack channels, meetings and decisions, with chats and a memory your agent keeps in {root || 'its repo'}.</p>
          {items.length ? (
            <div className={s.list} role="list" aria-label="Initiatives">
              {items.map((item) => (
                <InitiativeCard key={item.slug} item={item} now={now} />
              ))}
            </div>
          ) : (
            <Empty icon="flag" title="No initiatives yet" detail="Make one for the next thing you need to ship. Your agent keeps its memory and suggests what to do next; you approve." action={<Button icon="plus" onClick={handleNew}>New Initiative</Button>} />
          )}
        </div>
      </div>
      {making ? <NewInitiativeSheet close={handleClose} /> : null}
    </div>
  );
};
