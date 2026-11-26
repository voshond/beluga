import { useState } from 'react';
import { type InitiativeView } from '@beluga/core/initiatives/model.js';
import { type UnreadNews, type Watch, isWatching, nextLookWhen, unreadNews, watchPlaceLink, watchPlaceWords } from '@beluga/core/initiatives/watches.js';
import { Button } from '../components/ui.js';
import { openExternal } from '../lib/system.js';
import { useClock } from '../lib/window-active.js';
import { ago } from '../tasks/tasks-model.js';
import { Section } from './InitiativeParts.js';
import { useInitiativeActions } from './use-initiatives.js';
import { WatchSheet } from './WatchSheet.js';
import s from './initiatives.module.css';

const MINUTE = 60_000;

/** "in 5 min", "in 3 h", or the day and time of a later look. */
const soon = (at: number, now: number): string => {
  const left = at - now;
  if (left < MINUTE) return 'now';
  if (left < 60 * MINUTE) return `in ${Math.round(left / MINUTE)} min`;
  if (left < 12 * 60 * MINUTE) return `in ${Math.round(left / (60 * MINUTE))} h`;
  return new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};

const timeOf = (iso: string | undefined): number | undefined => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : undefined;
};

const WatchRow = ({ slug, watch, now }: { slug: string; watch: Watch; now: number }) => {
  const a = useInitiativeActions();
  const link = watchPlaceLink(watch.where);
  const looked = timeOf(watch.lastLook);
  const handleLook = (): void => void a.act(() => a.api.lookNow(slug, watch.id), 'Looking now: follow it in the Follow-ups chat');
  const handleStop = (): void => void a.act(() => a.api.stopWatch(slug, watch.id), 'Stopped watching it');
  const handleOpen = (): void => {
    if (link) void openExternal(link);
  };
  return (
    <div role="listitem" className={s.task} data-watch={watch.id}>
      <span className={s.taskText}>
        <span className={s.taskTitle}>{watch.what}</span>
        <span className={s.taskNotes}>
          {watch.waitingOn ? `${watch.waitingOn} · ` : ''}
          {link ? (
            <button type="button" className={s.epicLink} onClick={handleOpen} aria-label={`Open ${watchPlaceWords(watch.where)}`}>
              {watchPlaceWords(watch.where)}
            </button>
          ) : (
            watchPlaceWords(watch.where)
          )}
        </span>
      </span>
      <span className={s.taskWhen}>
        {looked ? `looked ${ago(looked, now)}` : 'not looked yet'} · next {soon(nextLookWhen(watch, now), now)}
      </span>
      <Button size="small" variant="quiet" onClick={handleLook} aria-label={`Look now: ${watch.what}`}>
        Look Now
      </Button>
      <Button size="small" variant="quiet" onClick={handleStop} aria-label={`Stop watching: ${watch.what}`}>
        Stop
      </Button>
    </div>
  );
};

const NewsRow = ({ slug, item, now }: { slug: string; item: UnreadNews; now: number }) => {
  const a = useInitiativeActions();
  const at = timeOf(item.news.at);
  const handleRead = (): void => void a.act(() => a.api.readNews(slug, item.watch.id));
  return (
    <div role="listitem" className={s.task} data-news={item.watch.id}>
      <span className={s.taskText}>
        <span className={s.taskTitle}>
          {item.news.from ? `${item.news.from}: ` : ''}
          {item.news.text}
        </span>
        <span className={s.taskNotes}>About: {item.watch.what}</span>
      </span>
      <span className={s.taskWhen}>{at ? ago(at, now) : ''}</span>
      <Button size="small" variant="quiet" onClick={handleRead} aria-label={`Mark read: ${item.watch.what}`}>
        Mark Read
      </Button>
    </div>
  );
};

/** Follow-ups the agent watches by itself: "New since you asked" (until read) and "Waiting for". */
export const WatchesSection = ({ item }: { item: InitiativeView }) => {
  const a = useInitiativeActions();
  const now = useClock(true, MINUTE);
  const [adding, setAdding] = useState(false);
  const watches = item.watches ?? [];
  const waiting = watches.filter(isWatching);
  const news = unreadNews(watches);
  const handleAdd = (): void => setAdding(true);
  const handleClose = (): void => setAdding(false);
  const handleReadAll = (): void => void a.act(() => a.api.readNews(item.slug));
  return (
    <>
      {news.length ? (
        <Section
          title="New since you asked"
          aside={
            <Button size="small" onClick={handleReadAll}>
              Mark All Read
            </Button>
          }
        >
          <div className={s.ticketList} role="list" aria-label="New since you asked">
            {news.map((n) => (
              <NewsRow key={`${n.watch.id}:${n.news.at}`} slug={item.slug} item={n} now={now} />
            ))}
          </div>
        </Section>
      ) : null}
      <Section
        title="Waiting for"
        aside={
          <Button size="small" icon="eye" onClick={handleAdd}>
            Watch for an Answer…
          </Button>
        }
      >
        {waiting.length ? (
          <div className={s.ticketList} role="list" aria-label="Waiting for">
            {waiting.map((w) => (
              <WatchRow key={w.id} slug={item.slug} watch={w} now={now} />
            ))}
          </div>
        ) : (
          <span className={s.quiet} role="status">
            Nothing to wait for. Sending a draft from the outbox watches for its answer by itself.
          </span>
        )}
      </Section>
      {adding ? <WatchSheet slug={item.slug} close={handleClose} /> : null}
    </>
  );
};
