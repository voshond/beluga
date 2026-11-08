import { Component, type ComponentType, type LazyExoticComponent, type ReactNode, lazy, useEffect } from 'react';
import type { View } from '@beluga/core/store.js';
import { Button, Empty } from '../components/ui.js';
import { useActions } from './actions.js';
import { useBeluga } from './beluga.js';
import { pageAlive } from './nav-pages.js';
import { chunk, isChunkLoadError, onChunkProblem, prefetchChunks, reportChunkProblem } from './chunks-model.js';

/**
 * A view in its own chunk (lib/chunks-model.ts): it gives up instead of waiting for good, and it's
 * fetched early while the window is idle (`first`: before the others; false: not, when another
 * place already fetches the same module).
 */
export function lazyView<P extends object>(name: string, importer: () => Promise<ComponentType<P>>, prefetch: boolean | 'first' = true): LazyExoticComponent<ComponentType<P>> {
  const c = chunk(name, importer, { prefetch });
  return lazy(() => c.load().then((view) => ({ default: view })));
}

/**
 * A view that breaks shows what happened and a way back, instead of blanking the window. A part
 * that didn't load is cached that way by React, and the origin that stalled stays stalled, so its
 * way back reloads the window (the daemon and your agents keep running; the window reconnects).
 */
export class ViewBoundary extends Component<{ children: ReactNode; at: string }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  override componentDidUpdate(prev: { at: string }): void {
    // Going somewhere else tries again.
    if (prev.at !== this.props.at && this.state.error) this.setState({ error: undefined });
  }
  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (isChunkLoadError(error)) {
      return (
        <Empty
          icon="alert"
          title="This view didn’t finish loading"
          detail="Reloading the window brings it back. Your agents and terminals keep running."
          action={
            <Button size="small" onClick={reloadWindow}>
              Reload
            </Button>
          }
        />
      );
    }
    return (
      <Empty
        icon="alert"
        title="This view ran into a problem"
        detail={error.message}
        action={
          <Button size="small" onClick={() => this.setState({ error: undefined })}>
            Try Again
          </Button>
        }
      />
    );
  }
}

let watching = false;
/** Vite's own preload of a chunk's imports failing: noted like a chunk that didn't load. */
export function watchPreloadErrors(): void {
  if (watching) return;
  watching = true;
  window.addEventListener('vite:preloadError', (e) => {
    const payload = (e as Event & { payload?: unknown }).payload;
    reportChunkProblem({ kind: 'failed', chunk: 'preload', ms: 0, message: payload instanceof Error ? payload.message : String(payload) });
  });
}

/** Where the window was when it reloaded for a part that didn't load: it comes back there. */
const RELOADED_AT = 'beluga.reloadedAt';
/** How long a reloaded window waits for that page to be there (its project listed) before giving up on it. */
const RETURN_WAIT_MS = 5000;
let viewNow: (() => View) | undefined;

/** Reload the window, and come back to the page on screen. */
function reloadWindow(): void {
  try {
    if (viewNow) sessionStorage.setItem(RELOADED_AT, JSON.stringify(viewNow()));
  } catch {
    // No session storage: the window reloads to its first page.
  }
  location.reload();
}

/** The page saved by reloadWindow, read once (and forgotten) when the window starts. */
function savedPage(): View | undefined {
  try {
    const saved = sessionStorage.getItem(RELOADED_AT);
    sessionStorage.removeItem(RELOADED_AT);
    return saved ? (JSON.parse(saved) as View) : undefined;
  } catch {
    return undefined;
  }
}
let returnTo: View | undefined | null = null;

/** After reloadWindow: show the page it was on, once it's there. */
function useReturnAfterReload(): void {
  const { client } = useBeluga();
  const actions = useActions();
  useEffect(() => {
    if (returnTo === null) returnTo = savedPage();
    if (!returnTo) return;
    const tryGo = (): boolean => {
      const view = returnTo;
      if (!view || !pageAlive(client.store.getState(), view)) return false;
      returnTo = undefined;
      actions.run({ type: 'view', view });
      return true;
    };
    if (tryGo()) return;
    const off = client.store.subscribe(() => void tryGo());
    const timer = setTimeout(() => (returnTo = undefined), RETURN_WAIT_MS);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [client, actions]);
}

let prefetched = false;
/**
 * Tell the daemon's black box about chunks that didn't load, fetch the views early (once a
 * window), and after a Reload for one, come back to the page you were on.
 */
export function useChunkCare(): void {
  const { client } = useBeluga();
  useEffect(() => {
    viewNow = () => client.store.getState().view;
    return onChunkProblem((p) => void client.api.diagnostics.windowProblem(p).catch(() => undefined));
  }, [client]);
  useReturnAfterReload();
  useEffect(() => {
    if (prefetched) return;
    prefetched = true;
    void prefetchChunks();
  }, []);
}
