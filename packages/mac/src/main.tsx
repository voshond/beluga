// First: zod never probes eval (blocked by the CSP, BLG-672), and Beluga's storage keys become Beluga's before any module reads them.
import './lib/zod-jitless.js';
import './lib/storage-rename.js';
// And Enter that picks an input method's words reaches no box (lib/ime-guard.ts), before anything else listens for keys.
import './lib/install-ime-guard.js';
import { Fragment, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { followOwnWords } from './i18n/own.js';
import { startI18n } from './i18n/start.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { App } from './App.js';
import { brandText } from './lib/brand.js';
import { capabilities, connect, inApp, Unreachable, native } from './lib/boot.js';
import { BelugaProvider } from './lib/beluga.js';
import { apply, zoom } from './lib/prefs.js';
import { useClock, watchWindow } from './lib/window-active.js';
import { watchPreloadErrors } from './lib/lazy-view.js';
import { pinWindow } from './lib/scroll-within.js';
import { Button } from './components/ui.js';
import { DotMatrix } from './components/DotMatrix.js';
import { connectNote, connectTitle, connectViewOf } from './lib/connect-model.js';
import { UpdateLayer } from './dialogs/UpdateSheet.js';
import { FolderBrowserHost } from './dialogs/FolderBrowser.js';
import { PartBoundary } from './lib/part-boundary.js';
import s from './layout/Shell.module.css';
import './styles/tokens.css';
import './styles/base.css';
// Dockview's own styles, then Beluga's look for them (the window's frame and the panel's dock).
import 'dockview-react/dist/styles/dockview.css';
import './styles/dock.css';
// Last: a phone-wide window's sizes win (BLG-6).
import './styles/phone.css';

apply();
if (native('look')) document.documentElement.dataset.app = 'tauri';
watchWindow();
watchPreloadErrors();
pinWindow();

// Beluga in a browser (docs/web.md): a redeploy builds the window again under an open page, and a
// part it loads later (a view) may be gone. Load the page again, at most once a minute (no loop).
if (!inApp()) {
  window.addEventListener('vite:preloadError', (event) => {
    const KEY = 'beluga.reloadedForBuild';
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY)) || 0;
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      // No storage: reload anyway (a loop needs storage to be noticed, and a reload is what fixes it).
    }
    event.preventDefault();
    location.reload();
  });
}

/** Attach to Beluga, and keep trying while it starts (or comes back). */
function Root() {
  const [client, setClient] = useState<SocketClient>();
  const [error, setError] = useState<string>();
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  // Since this window began trying (it opened, or Beluga went away), and whether it was ever attached.
  const since = useRef(Date.now());
  const wasConnected = useRef(false);
  useEffect(() => {
    let alive = true;
    // Waits longer each time in a row it fails (up to 10 s), so a broken Beluga isn't hammered.
    const retry = (): void => void setTimeout(() => alive && setAttempt((n) => n + 1), Math.min(10_000, 500 * 2 ** Math.min(failures.current++, 5)));
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Beluga didn't answer")), 15_000));
    Promise.race([connect(capabilities(zoom)), timeout])
      .then((c) => {
        if (!alive) return c.close();
        setError(undefined);
        setUnreachable(false);
        // Before the first draw: names people gave things stay as they are (i18n/own.ts).
        const offWords = followOwnWords(c.store);
        setClient(c);
        wasConnected.current = true;
        const attached = Date.now();
        c.onClose(() => {
          offWords();
          since.current = Date.now();
          setClient(undefined);
          // Dropped right away (Beluga turned the screen away): wait before trying again.
          if (Date.now() - attached < 5000) return retry();
          failures.current = 0;
          setAttempt((n) => n + 1);
        });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setUnreachable(err instanceof Unreachable);
        setError(err instanceof Error ? err.message : String(err));
        retry();
      });
    return () => {
      alive = false;
    };
  }, [attempt]);
  // While waiting, the words follow how long it has been (lib/connect-model.ts): looked at again each
  // second, and only while you're looking at the window (useClock rests otherwise, KLD-40).
  const now = useClock(!client);
  if (!client) {
    // An attempt that fails while Beluga starts is no problem yet: it reads as starting, and the
    // reason and Try again come only once it has really taken long.
    const waitedMs = Math.max(0, now - since.current);
    // A server that can't be reached is a problem at once (a thin client), not a start that takes a while.
    const view = unreachable && error ? 'slow' : connectViewOf({ failed: Boolean(error), waitedMs, wasConnected: wasConnected.current });
    const note = connectNote(view, waitedMs);
    return (
      <div className={s.connecting} data-tauri-drag-region>
        <UpdateLayer connected={false} />
        <div className={s.connectBox} role="status">
          {view === 'slow' ? null : <DotMatrix size={18} />}
          <strong>{view === 'slow' && unreachable ? 'Can’t reach Beluga' : connectTitle(view, wasConnected.current)}</strong>
          {note ? <span>{note}</span> : null}
          {view === 'slow' && error ? <span className={s.connectWhy}>{brandText(error)}</span> : null}
          {view === 'slow' ? <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button> : null}
        </div>
      </div>
    );
  }
  return (
    // Anything that throws while drawing shows why, with a way back, instead of a grey window (BLG-905).
    <PartBoundary part="window" onCrash={(crash) => void client.api.diagnostics.windowCrash(crash).catch(() => undefined)} fallback={(error) => <WindowBroken error={error} />}>
      <BelugaProvider client={client}>
        <App />
        <UpdateLayer connected />
        {/* A browser's folder picker, and in the app a computer's (BLG-793). */}
        <FolderBrowserHost />
      </BelugaProvider>
    </PartBoundary>
  );
}

/** The whole window couldn't be drawn: what went wrong, and Reload (your agents and terminals keep running). */
function WindowBroken({ error }: { error: Error }) {
  return (
    <div className={s.connecting} data-tauri-drag-region>
      <div className={s.connectBox} role="alert">
        <strong>Beluga’s window ran into a problem</strong>
        <span>{brandText(error.message)}</span>
        <span>Reloading the window brings it back. Your agents and terminals keep running, and Report a Problem in Settings › About includes what happened.</span>
        <Button onClick={() => location.reload()}>Reload Window</Button>
      </div>
    </div>
  );
}

/**
 * StrictMode draws everything twice while developing (never in the app you ship): a timing test
 * (e2e/render-calm.spec.ts) opens `/?nostrict` to time what the app itself does.
 */
const Strict = import.meta.env.DEV && new URLSearchParams(location.search).has('nostrict') ? Fragment : StrictMode;

// The window's language first (src/i18n), so its first frame is already in it.
void startI18n({ native: true }).then(() =>
  createRoot(document.getElementById('root')!).render(
    <Strict>
      <Root />
    </Strict>,
  ),
);
