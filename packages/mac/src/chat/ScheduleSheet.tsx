import { useState } from 'react';
import type { OnceTrigger, ScheduleTrigger } from '@beluga/core/sentinel/model.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Field, FormSheet, TextArea, TextInput } from '../components/FormSheet.js';
import { Segmented } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { OnceControls } from '../sentinel/EventControls.js';
import { ScheduleControls } from '../sentinel/SentinelCards.js';
import { useSentinelActions } from '../sentinel/use-sentinel.js';
import { isoLocal, nextWholeHour, onceAhead, onceIn, scheduleDraft } from './schedule-model.js';
import s from '../sentinel/sentinel.module.css';

/**
 * Make a schedule from a chat (BLG-400): '/schedule' or the Schedules section's '+'. When (a
 * repeating schedule, once at a moment, or in N hours) and the prompt; it makes a sentinel with one
 * chat step to this chat. You made it by hand, so it starts on (an agent's starts paused).
 */

type When = 'repeat' | 'once' | 'in';

const WHEN: ReadonlyArray<{ readonly value: When; readonly label: string }> = [
  { value: 'repeat', label: 'Repeats' },
  { value: 'once', label: 'Once' },
  { value: 'in', label: 'In hours' },
];
const FIRST_SCHEDULE: ScheduleTrigger = { kind: 'schedule', every: 'day', at: '09:00', missed: 'skip' };

export function ScheduleSheet({ channel, prompt: first = '', close }: { channel: string; prompt?: string; close: () => void }) {
  const a = useSentinelActions();
  const self = useApp((st) => st.selfId);
  const projectId = useApp((st) => (channel.startsWith('ws:') ? findWorkspace(st.projects, channel.slice(3))?.projectId : undefined));
  const [when, setWhen] = useState<When>('repeat');
  const [schedule, setSchedule] = useState<ScheduleTrigger>(FIRST_SCHEDULE);
  const [once, setOnce] = useState<OnceTrigger>(() => ({ kind: 'once', at: isoLocal(nextWholeHour(Date.now())), missed: 'catch-up' }));
  const [hours, setHours] = useState('5');
  const [prompt, setPrompt] = useState(first);
  const n = Number(hours);
  const hoursOk = Number.isFinite(n) && n > 0 && n <= 24 * 30;
  const ready = Boolean(prompt.trim()) && (when !== 'in' || hoursOk) && (when !== 'once' || onceAhead(once, Date.now()));

  const make = async (): Promise<void> => {
    const trigger = when === 'repeat' ? schedule : when === 'once' ? once : onceIn(n, Date.now());
    // A refusal throws: the sheet shows its words and stays open.
    const made = await a.create(scheduleDraft({ trigger, prompt, ref: `${self}/${channel}`, ...(projectId ? { projectId } : {}) }));
    await a.setPaused(made, false);
    close();
  };

  return (
    <FormSheet title="Schedule a Message" intro="Sends a prompt into this chat on a schedule, as from Sentinel." icon="clock" submitLabel="Schedule" canSubmit={ready} onSubmit={make} onCancel={close}>
      <Field label="When">
        <div className={s.controls}>
          <div className={s.every}>
            <Segmented radio label="When" value={when} onChange={setWhen} options={WHEN} />
          </div>
          {when === 'repeat' ? <ScheduleControls t={schedule} set={setSchedule} /> : null}
          {when === 'once' ? <OnceControls t={once} set={setOnce} /> : null}
          {when === 'in' ? (
            <div className={s.controlRow}>
              <span className={s.controlLabel}>In</span>
              <TextInput aria-label="In how many hours" inputMode="decimal" value={hours} onChange={setHours} invalid={!hoursOk} style={{ width: 72 }} />
              <span className={s.hint}>hours</span>
            </div>
          ) : null}
        </div>
      </Field>
      <Field label="Prompt">
        <TextArea aria-label="Prompt" autoFocus rows={4} placeholder="What to send into this chat" value={prompt} onChange={setPrompt} />
      </Field>
    </FormSheet>
  );
}
