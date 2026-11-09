import { Icon, type IconName } from '../components/Icon.js';
import { Dot, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp, useUi } from '../lib/beluga.js';
import { Row } from '../layout/sidebar-parts.js';
import { DotMark } from '../layout/signal-marks.js';
import { sameDeep } from '../lib/stable.js';
import { ago } from '../tasks/tasks-model.js';
import { useClock } from '../lib/window-active.js';
import { SIDE_RUNS, type SideRun, type SideSentinel, anyRunning, iconOf, isSentinelView, needsALook, sidebarLine, sidebarSentinels } from './sentinel-model.js';
import { useSentinelActions } from './use-sentinel.js';
import g from '../layout/project-groups.module.css';
import side from '../layout/Sidebar.module.css';
import s from './sentinel-nav.module.css';

export { isSentinelView };

/**
 * The sidebar's Sentinel row, always there under Work: the one row for the whole section (its
 * Sentinels, Dashboard and Chat tabs are on its page). Its line (the row's hint): how many watch
 * and when the next runs, or "Paused after 3 failures" with the problem mark; a live dot while a run goes.
 * The sentinels follow it (SentinelSideRows): folded (the default), only those that need a look;
 * unfolded with its triangle, every one that's on.
 */
export function SentinelNav() {
  const actions = useActions();
  const { line, live, selected } = useApp((st) => ({ line: sidebarLine(st.sentinel), live: anyRunning(st.sentinel), selected: isSentinelView(st.view.kind) }), sameDeep);
  const all = useUi((u) => u.collapsed.includes(ROWS_KEY));
  const counts = useApp((st) => (st.sentinel.enabled ? sidebarSentinels(st.sentinel) : []).reduce((c, x) => ({ on: c.on + 1, quiet: c.quiet + (needsALook(x) ? 0 : 1) }), { on: 0, quiet: 0 }), sameDeep);
  const toggle = (): void => actions.run({ type: 'toggle_fold', key: ROWS_KEY });
  const fold = counts.quiet ? (
    <button type="button" className={g.foldButton} aria-expanded={all} aria-label={all ? 'Show only the sentinels that need a look' : `Show all ${counts.on} sentinels that are on`} title={all ? 'Show only the ones that need a look' : `Show all ${counts.on} that are on`} onClick={(e) => (e.stopPropagation(), toggle())}>
      <Icon name="chevronRight" size={9} className={cx(g.disclosure, all && g.disclosureOpen)} />
    </button>
  ) : null;
  const mark = live ? <Dot tone="claude" live /> : line.problem ? <Icon name="alert" size={12} className={s.alert} /> : null;
  return (
    <>
      <Row
        icon={<Icon name="sentinel" size={14} />}
        label="Sentinel"
        detail={line.text}
        selected={selected}
        onClick={() => actions.run({ type: 'view', view: { kind: 'sentinel' } })}
        trailing={mark || fold ? <span className={s.rowEnd}>{mark}{fold}</span> : null}
        onKeyDown={(e) => {
          // → shows every sentinel, ← only those that need a look (as a project folds).
          if (counts.quiet && e.target === e.currentTarget && ((e.key === 'ArrowRight' && !all) || (e.key === 'ArrowLeft' && all))) {
            e.preventDefault();
            toggle();
          }
        }}
        data-sentinel-row=""
        aria-current={selected ? 'page' : undefined}
        data-problem={line.problem || undefined}
      />
      <SentinelSideRows all={all} />
    </>
  );
}

/** Every sentinel that's on shows under the Sentinel row while this key is in the folds; else only those that need a look. */
const ROWS_KEY = 'sentinel-rows';

/** A sentinel's runs are unfolded under it while this key is in the folds (folded by default). */
const runsKey = (id: string): string => `sentinel-runs:${id}`;

/**
 * Under the Sentinel row (BLG-570), as running plans are under Work: the sentinels, each opening its
 * page and unfolding to its runs (BLG-576), newest first. `all`: every one that's on; else only
 * those running, waiting for you, whose last run failed, or that stopped on their own.
 */
export function SentinelSideRows({ all }: { all: boolean }) {
  const enabled = useApp((st) => st.sentinel.enabled);
  const items = useApp((st) => sidebarSentinels(st.sentinel), sameDeep);
  if (!enabled) return null;
  return (
    <>
      {(all ? items : items.filter(needsALook)).map((x) => (
        <SentinelSideRow key={x.sentinel.id} item={x} />
      ))}
    </>
  );
}

function SentinelSideRow({ item }: { item: SideSentinel }) {
  const actions = useActions();
  const a = useSentinelActions();
  const { sentinel, live, needs, failed, broken, runs } = item;
  const open = useUi((u) => u.collapsed.includes(runsKey(sentinel.id)));
  const selected = useApp((st) => st.view.kind === 'sentinel_page' && st.view.id === sentinel.id);
  const toggle = (): void => actions.run({ type: 'toggle_fold', key: runsKey(sentinel.id) });
  const tip = needs ? `${sentinel.name} waits for you` : live ? `${sentinel.name} is running` : broken ? `${sentinel.name}: ${broken}` : failed ? `${sentinel.name}: its last run failed` : `${sentinel.name}: ${runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : 'no runs yet'}`;
  return (
    <>
      <Row
        indent={1}
        selected={selected}
        className={side.foldRow}
        aria-label={sentinel.name}
        aria-expanded={runs.length ? open : undefined}
        data-sentinel-side={sentinel.id}
        icon={
          <span className={s.sideIcon}>
            {runs.length ? (
              <button type="button" className={g.foldButton} aria-label={open ? `Fold ${sentinel.name}’s runs` : `Show ${sentinel.name}’s runs`} onClick={(e) => (e.stopPropagation(), toggle())}>
                <Icon name="chevronRight" size={9} className={cx(g.disclosure, open && g.disclosureOpen)} />
              </button>
            ) : (
              <span className={g.foldButton} aria-hidden="true" />
            )}
            <Icon name={iconOf(sentinel.icon)} size={13} />
          </span>
        }
        label={sentinel.name}
        detail={tip}
        onClick={() => a.open(sentinel.id)}
        onKeyDown={(e) => {
          // ← folds, → unfolds (as a project does).
          if (runs.length && e.target === e.currentTarget && ((e.key === 'ArrowLeft' && open) || (e.key === 'ArrowRight' && !open))) {
            e.preventDefault();
            toggle();
          }
        }}
        trailing={live ? <DotMark tone="claude" live signal="working" /> : needs ? <DotMark tone="warn" signal="needs" /> : failed || broken ? <Icon name="alert" size={12} className={s.alert} /> : null}
      />
      {open ? <SideRuns sentinelId={sentinel.id} runs={runs} /> : null}
    </>
  );
}

/** A run's mark in the sidebar: how it went, as its page's timeline marks steps. */
const RUN_ICON: Readonly<Record<SideRun['state'], IconName>> = { done: 'check', failed: 'x', stopped: 'stop', skipped: 'minus', queued: 'clock', running: 'clock', 'needs-you': 'merge' };

function SideRuns({ sentinelId, runs }: { sentinelId: string; runs: readonly SideRun[] }) {
  const a = useSentinelActions();
  const now = useClock(true, 60_000);
  const here = useApp((st) => (st.view.kind === 'sentinel_run' ? st.view.runId : undefined));
  return (
    <>
      {runs.slice(0, SIDE_RUNS).map((r) => (
        <Row
          key={r.runId}
          indent={2}
          selected={here === r.runId}
          aria-label={r.headline}
          data-sentinel-run={r.runId}
          data-state={r.state}
          icon={<Icon name={RUN_ICON[r.state]} size={12} className={s.runMark} data-state={r.state} />}
          label={<span className={s.runLine}>{r.headline}</span>}
          detail={`${r.headline} · ${ago(r.startedAt, now)}${r.chat ? '' : ' · no agent chat kept'}`}
          onClick={() => a.openRun(r.runId)}
          trailing={r.state === 'running' || r.state === 'queued' ? <DotMark tone="claude" live signal="working" /> : r.state === 'needs-you' ? <DotMark tone="warn" signal="needs" /> : <span className={s.when}>{ago(r.startedAt, now)}</span>}
        />
      ))}
      {runs.length > SIDE_RUNS ? <Row indent={2} className={s.more} label={`All ${runs.length} on its page`} onClick={() => a.open(sentinelId)} /> : null}
    </>
  );
}
