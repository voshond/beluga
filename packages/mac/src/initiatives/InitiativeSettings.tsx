import { type ChangeEvent, useState } from 'react';
import { CHECK_IN_TIME, type CheckInSchedule, type InitiativeView } from '@beluga/core/initiatives/model.js';
import { DAY_NAMES, type Trigger, scheduleSentence } from '@beluga/core/sentinel/model.js';
import { Icon } from '../components/Icon.js';
import { Button, IconButton } from '../components/ui.js';
import { Switch } from '../dialogs/settings-controls.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { WEEK, toggleDay } from '../sentinel/sentinel-model.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { MemoryFileSheet } from './MemoryFileSheet.js';
import { Section } from './InitiativeParts.js';
import { useInitiativeActions } from './use-initiatives.js';
import sentinel from '../sentinel/sentinel.module.css';
import s from './initiatives.module.css';

const DEFAULT_CHECK_IN: CheckInSchedule = { at: '08:00', days: [1, 2, 3, 4, 5] };

const scheduleOf = (trigger: Trigger | undefined): CheckInSchedule => (trigger?.kind === 'schedule' && trigger.every === 'week' ? { at: trigger.at, days: trigger.days?.length ? [...trigger.days] : [1] } : DEFAULT_CHECK_IN);

export const CheckInRow = ({ item }: { item: InitiativeView }) => {
  const a = useInitiativeActions();
  const checkIn = useApp((st) => {
    const found = item.checkIn ? st.sentinel.items.find((x) => x.id === item.checkIn) : undefined;
    return found ? { on: !found.paused, next: st.sentinel.nextAt[found.id], trigger: found.trigger } : undefined;
  }, sameDeep);
  const on = Boolean(checkIn?.on);
  const schedule = scheduleOf(checkIn?.trigger);
  const sentence = checkIn?.trigger ? scheduleSentence(checkIn.trigger) : scheduleSentence({ kind: 'schedule', every: 'week', ...DEFAULT_CHECK_IN, missed: 'catch-up' });
  const handleToggle = (next: boolean): void => void a.act(() => a.api.setCheckIn(item.slug, next), next ? `Check-ins are on: ${sentence.toLowerCase()}` : 'Check-ins are off');
  const handleNow = (): void => void a.act(() => a.api.checkInNow(item.slug), 'Checking in: follow it in the Check-in chat').then((done) => done && a.open(item, 'checkin'));
  const handleSchedule = (next: CheckInSchedule): void => void a.act(() => a.api.setCheckInTime(item.slug, next));
  const handleTime = (event: ChangeEvent<HTMLInputElement>): void => {
    if (!CHECK_IN_TIME.test(event.target.value) || event.target.value === schedule.at) return;
    handleSchedule({ ...schedule, at: event.target.value });
  };
  const handleDay = (day: number): void => handleSchedule({ ...schedule, days: toggleDay(schedule.days, day) });
  const when = on && checkIn?.next ? `next ${new Date(checkIn.next).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'off';
  return (
    <div className={s.checkIn}>
      <div className={s.checkInLine}>
        <Switch on={on} onChange={handleToggle} label="Check-ins" />
        <span>
          Check-in {sentence.charAt(0).toLowerCase() + sentence.slice(1)} · {when}
        </span>
        <span className={s.grow} />
        <Button size="small" icon="refresh" onClick={handleNow}>
          Check In Now
        </Button>
      </div>
      <div className={s.checkInLine}>
        <input type="time" className={sentinel.time} aria-label="Check-in time" value={schedule.at} onChange={handleTime} />
        <span className={sentinel.days} role="group" aria-label="Check-in days">
          {WEEK.map((day) => (
            <button key={day} type="button" className={sentinel.day} aria-pressed={schedule.days.includes(day)} onClick={() => handleDay(day)}>
              {DAY_NAMES[day]}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
};

export const Repos = ({ item }: { item: InitiativeView }) => {
  const a = useInitiativeActions();
  const projectNames = useApp((st) => st.projects.filter((p) => p.root && !p.error).map((p) => p.name).join('\n'));
  const unlinked = (projectNames ? projectNames.split('\n') : []).filter((p) => !item.repos.includes(p));
  const handleLink = (repo: string): void => void a.act(() => a.api.setRepo(item.slug, repo, true));
  const handleUnlink = (repo: string): void => void a.act(() => a.api.setRepo(item.slug, repo, false));
  const add = unlinked.length ? (
    <PickMenu<string> label="Link a repo" choices={unlinked.map((p) => ({ value: p, label: p, mark: <Icon name="folder" size={13} /> }))} chosen={[]} onPick={handleLink} align="end">
      <IconButton size="small" icon="plus" label="Link a repo" />
    </PickMenu>
  ) : null;
  return (
    <Section title="Repos" aside={add}>
      {item.repos.length ? (
        <div className={s.chips}>
          {item.repos.map((repo) => (
            <span key={repo} className={s.chip}>
              <Icon name="folder" size={12} />
              {repo}
              <button type="button" className={s.chipRemove} aria-label={`Unlink ${repo}`} onClick={() => handleUnlink(repo)}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <span className={s.quiet}>No repos linked: link one so its chats can start tasks there.</span>
      )}
    </Section>
  );
};

export const MemoryFiles = ({ item }: { item: InitiativeView }) => {
  const [open, setOpen] = useState<string>();
  const handleClose = (): void => setOpen(undefined);
  return (
    <Section title="Memory">
      <div className={s.files}>
        {item.files.map((file) => (
          <button key={file} type="button" className={s.file} onClick={() => setOpen(file)} aria-label={`Open ${file}`}>
            <Icon name="fileText" size={12} />
            {file}
          </button>
        ))}
      </div>
      <span className={s.quiet}>{item.folder}</span>
      {open ? <MemoryFileSheet slug={item.slug} file={open} close={handleClose} /> : null}
    </Section>
  );
};
