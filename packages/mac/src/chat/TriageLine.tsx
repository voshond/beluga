import { categoryOf, triageKey } from '@beluga/core/triage/model.js';
import { remindLabel } from '@beluga/shared/remind.js';
import { laterUntil, triageFacts } from '@beluga/core/triage/facts.js';
import { Button } from '../components/ui.js';
import { settledWords } from '../layout/attention-model.js';
import { unsettle, wake } from '../layout/row-triage-actions.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { useClock } from '../lib/window-active.js';
import s from './TriageLine.module.css';

/**
 * One line above the message box of a chat put off till later (when it reminds you, with the
 * categories on or off) or Settled (why): and the way back. The box itself works the same in every
 * category: sending brings the chat back.
 */
export function TriageLine({ channel }: { channel: string }) {
  const { client } = useBeluga();
  const line = useApp((state) => {
    const key = triageKey(state, channel);
    if (!key) return undefined;
    const record = state.triage[key];
    const until = laterUntil(state, channel);
    const category = categoryOf(record, triageFacts(state, key));
    if (!state.prefs.chatCategories) return until !== undefined ? ({ kind: 'snoozed', until } as const) : undefined;
    if (category === 'settled' && record?.settled) return { kind: 'settled', settled: record.settled, idleDays: state.prefs.settleIdleDays } as const;
    if (category === 'snoozed' && record?.snoozed) return { kind: 'snoozed', until: record.snoozed.until } as const;
    return undefined;
  }, sameDeep);
  const now = useClock(line !== undefined, 30_000);
  if (!line) return null;
  return (
    <div className={s.line} role="status" aria-label="Chat category">
      <span className={s.words}>{line.kind === 'settled' ? settledWords(line.settled, line.idleDays, now) : remindLabel(line.until, now) || 'Reminds you now'}</span>
      {line.kind === 'settled' ? (
        <Button size="small" onClick={() => void unsettle(client, channel)}>
          Un-settle
        </Button>
      ) : (
        <Button size="small" onClick={() => void wake(client, channel)}>
          Show Again Now
        </Button>
      )}
    </div>
  );
}
