import { THREAD_LIMITS_DEFAULT, THREAD_LIMIT_ROWS, type ThreadLimits } from '@beluga/shared/threads.js';
import { useApi, useApp } from '../lib/beluga.js';
import { Group, Row, Select, Switch } from './settings-controls.js';

/** Settings › Advanced › Agent threads: whether your agents' runs get the thread tools. Off, the next run has none. */
export function AgentThreadsSettings() {
  const api = useApi();
  const on = useApp((st) => st.prefs.agentThreads ?? false);
  return (
    <Group title="Agent threads">
      <Row label="Let your agents start threads" detail="An agent can start child chats, each with its own agent, and read their results. Only you change this. It applies from the next run.">
        <Switch label="Agent threads" on={on} onChange={(v) => void api.session.setPrefs({ agentThreads: v })} />
      </Row>
    </Group>
  );
}

/** Settings › Agent › Thread limits: how far your agents' threads go. The next thread_start reads them. */
export function ThreadLimitsSettings() {
  const api = useApi();
  const limits = useApp((st) => st.prefs.threadLimits ?? THREAD_LIMITS_DEFAULT);
  const set = (key: keyof ThreadLimits, value: number): void => void api.session.setPrefs({ threadLimits: { ...limits, [key]: value } });
  return (
    <Group title="Thread limits">
      {THREAD_LIMIT_ROWS.map(({ key, label, detail, presets }) => {
        // A number set in settings.json by hand still shows as itself.
        const values = presets.includes(limits[key]) ? presets : [...presets, limits[key]].sort((a, b) => a - b);
        return (
          <Row key={key} label={label} detail={detail}>
            <Select label={label} value={String(limits[key])} onChange={(v) => set(key, Number(v))} options={values.map((n) => ({ value: String(n), label: String(n) }))} />
          </Row>
        );
      })}
    </Group>
  );
}
