import type { View } from '@beluga/core/store.js';
import { cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { onMachine } from './pane-model.js';
import { type Tagged, whereLine } from './remote-work.js';
import { MachineChip } from './RemoteRows.js';
import c from './machines.module.css';

/**
 * A list's work on your computers (BLG-785): Plans, Sentinels, Tasks and Dashboards each show
 * theirs after this Mac's, every row with its computer's mark and short name; an offline
 * computer's greyed, saying when it was seen. Opening one opens it in the pane with that
 * computer's client. Nothing shows when there's none.
 */

export interface RemoteItem {
  readonly id: string;
  readonly title: string;
  /** One line under it (a project, a status). */
  readonly sub?: string;
  /** Its page on the computer. */
  readonly page: View;
}

export function RemoteList({ title = 'On your computers', rows }: { title?: string; rows: ReadonlyArray<Tagged<RemoteItem>> }) {
  const actions = useActions();
  if (!rows.length) return null;
  return (
    <section className={c.remoteList} aria-label={title}>
      <div className={c.remoteHead}>{title}</div>
      <ul>
        {rows.map((t) => (
          <li key={`${t.machine.id}/${t.item.id}`}>
            <button type="button" className={cx(c.remoteRow, t.offline && c.offlineRow)} title={whereLine(t)} aria-label={`${t.item.title} on ${t.machine.name}`} onClick={() => actions.run({ type: 'view', view: onMachine(t.machine.id, t.item.page) })}>
              <span className={c.remoteMain}>
                <span className={c.remoteTitle}>{t.item.title}</span>
                {t.item.sub || t.offline ? <span className={c.remoteSub}>{[t.item.sub, t.offline ? whereLine(t) : undefined].filter(Boolean).join(' · ')}</span> : null}
              </span>
              <MachineChip machine={t.machine} offline={t.offline} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
