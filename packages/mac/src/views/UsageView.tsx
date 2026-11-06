import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, EmptyActions } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { ActivityCard } from './usage/ActivityCard.js';
import { Breakdown } from './usage/Breakdown.js';
import { CleanupCard } from './usage/CleanupCard.js';
import { PlanCard } from './usage/PlanCard.js';
import { StorageCard } from './usage/StorageCard.js';
import { type SortKey, cleanups, projectRows } from './usage/usage-model.js';
import s from './usage/usage.module.css';

const SORT_KEY = 'beluga.usage.sort';
const isSort = (v: unknown): v is SortKey => v === 'size' || v === 'tokens' || v === 'recent';

/** The breakdown's order, remembered in this window between visits. */
function useSort(): [SortKey, (s: SortKey) => void] {
  const [sort, setSort] = useState<SortKey>(() => {
    try {
      const saved = localStorage.getItem(SORT_KEY);
      return isSort(saved) ? saved : 'size';
    } catch {
      return 'size';
    }
  });
  const choose = useCallback((next: SortKey) => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // Private mode: it's only remembered until the window closes.
    }
  }, []);
  return [sort, choose];
}

/** Measures every folder when the view opens (and on request); `measuring` while it runs. */
function useMeasure(): { measuring: boolean; measure: () => void } {
  const api = useApi();
  const { client } = useBeluga();
  const [measuring, setMeasuring] = useState(true);
  const measure = useCallback(() => {
    setMeasuring(true);
    api.workbench
      .measureDisk()
      .catch((err: unknown) => toast(client, `Couldn’t measure disk space: ${err instanceof Error ? err.message : String(err)}`, 'warn'))
      .finally(() => setMeasuring(false));
  }, [api, client]);
  useEffect(measure, [measure]);
  return { measuring, measure };
}

/**
 * Usage: your Claude plan's limits (and friends'), what Claude used this week, and the disk your worktrees take, by project; then every project and worktree side by side, with what
 * can be put away to free space.
 */
export function UsageView() {
  const actions = useActions();
  const state = useApp((st) => st);
  const [sort, setSort] = useSort();
  const { measuring, measure } = useMeasure();
  const now = Date.now();
  const rows = projectRows(state, sort);
  // Sizes known: the first measurement came back (or there was one from before).
  const measured = !measuring || rows.some((p) => p.rows.some((r) => r.disk !== undefined));
  if (!state.projects.some((p) => p.root) && !rows.length) {
    return (
      <Empty
        icon="gauge"
        title="Nothing to measure yet"
        detail="Add your projects: the disk their worktrees take and what your agent uses in them show up here."
        action={
          <EmptyActions>
            <Button variant="primary" icon="plus" onClick={() => actions.run({ type: 'add_project' })}>
              Add Projects…
            </Button>
          </EmptyActions>
        }
      />
    );
  }
  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.summaryFit}>
          <div className={s.summary}>
            <PlanCard state={state} now={now} />
            <ActivityCard state={state} now={now} />
          </div>
        </div>
        <StorageCard rows={rows} measuring={measuring} measured={measured} onMeasure={measure} />
        {measured ? <CleanupCard items={cleanups(state, rows, now)} state={state} onDone={measure} /> : null}
        <Breakdown state={state} rows={rows} sort={sort} onSort={setSort} measured={measured} now={now} />
      </div>
    </div>
  );
}
