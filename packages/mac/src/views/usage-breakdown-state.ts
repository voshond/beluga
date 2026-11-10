import { useCallback, useEffect, useState } from 'react';
import type { UsageSummary } from '@beluga/core/usage-report.js';
import { useApi } from '../lib/beluga.js';

type BreakdownState = {
  readonly summary?: UsageSummary;
  readonly loading: boolean;
  readonly error?: string;
  readonly for?: string;
};

const errorText = (err: Error | string): string => (err instanceof Error ? err.message : err);

export const useUsageBreakdown = (id: string, key: string): BreakdownState & { readonly reload: () => void } => {
  const api = useApi();
  const [state, setState] = useState<BreakdownState>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...(s.for === id ? { summary: s.summary } : {}), loading: true, for: id }));
    api.workspaces
      .usageBreakdown(id)
      .then((summary) => live && setState({ ...(summary ? { summary } : {}), loading: false, for: id }))
      .catch((err: Error | string) => live && setState({ loading: false, error: errorText(err), for: id }));
    return () => {
      live = false;
    };
  }, [api, id, key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...(state.for === id ? state : { loading: true }), reload };
};
