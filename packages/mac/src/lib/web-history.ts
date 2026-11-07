import { useEffect, useSyncExternalStore } from 'react';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { Actions } from './actions.js';
import { inApp } from './boot.js';
import { viewFromHash, viewToHash } from './web-history-model.js';

type HistoryEntry = { readonly belugaDepth?: number };

const listeners = new Set<() => void>();
let depth = 0;

const readDepth = (): number => {
  const entry: HistoryEntry | null = history.state;
  return typeof entry?.belugaDepth === 'number' ? entry.belugaDepth : 0;
};

const setDepth = (next: number): void => {
  depth = next;
  for (const listener of [...listeners]) listener();
};

const subscribeDepth = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useCanGoBack = (): boolean => useSyncExternalStore(subscribeDepth, () => depth > 0);

export const goBack = (): void => history.back();

export const useWebHistory = (client: SocketClient, actions: Actions): void => {
  useEffect(() => {
    if (inApp()) return;
    let shown = location.hash;
    let replacing = true;

    const handleStoreChange = (): void => {
      const hash = viewToHash(client.store.getState().view);
      if (!hash || hash === shown) return;
      shown = hash;
      if (replacing) return history.replaceState({ belugaDepth: depth }, '', hash);
      setDepth(depth + 1);
      history.pushState({ belugaDepth: depth }, '', hash);
    };

    const restore = (): void => {
      const view = viewFromHash(location.hash);
      replacing = true;
      if (view) actions.run({ type: 'view', view });
      handleStoreChange();
      replacing = false;
    };

    const handlePopState = (): void => {
      setDepth(readDepth());
      shown = location.hash;
      restore();
    };

    setDepth(readDepth());
    restore();
    const off = client.store.subscribe(handleStoreChange);
    window.addEventListener('popstate', handlePopState);
    return () => {
      off();
      window.removeEventListener('popstate', handlePopState);
    };
  }, [client, actions]);
};
