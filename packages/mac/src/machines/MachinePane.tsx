import { type ReactNode, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { Button, Empty } from '../components/ui.js';
import { MenuSheet } from '../dialogs/MenuSheet.js';
import { NativeSheets } from '../dialogs/native/WorkSheets.js';
import { Main } from '../layout/Main.js';
import { RightPanel } from '../layout/RightPanel.js';
import { MachineProvider, useApp, useBeluga } from '../lib/beluga.js';
import s from '../layout/Shell.module.css';
import { MachineMark } from './MachineMark.js';
import { paneOf, paneViewFor, windowViewFor } from './pane-model.js';
import { background, retryMachine, useMachinePane } from './pane-clients.js';
import { useMachineView } from './use-machines.js';
import c from './machines.module.css';

/**
 * The window's center and panel (BLG-784): this Mac's, or, on a page of one of your computers,
 * the same views drawn with that computer's client, so its chat, files, terminal and changes are
 * its own. The UI is always this app's; only state and calls come from the computer.
 */
export function Pane() {
  const machine = useApp((st) => paneOf(st.view).machine);
  if (!machine) {
    return (
      <>
        <Main />
        <RightPanel />
      </>
    );
  }
  return <MachinePane key={machine} machine={machine} />;
}

function MachinePane({ machine }: { machine: string }) {
  const { client: home, ui: windowUi } = useBeluga();
  const pane = useMachinePane(machine, home, windowUi);
  const view = useMachineView(home, machine);
  const name = view?.name ?? 'your computer';
  if (!pane.client) {
    return (
      <main className={s.main} data-tauri-drag-region>
        <Empty
          icon="server"
          {...(view ? { mark: <MachineMark machine={view} size={22} /> } : {})}
          title={pane.error ? `${name} can’t be reached` : `Opening ${name}…`}
          {...(pane.error ? { detail: pane.error } : {})}
          {...(pane.error
            ? {
                action: (
                  <Button size="small" onClick={() => retryMachine(machine, home, windowUi)}>
                    Try Again
                  </Button>
                ),
              }
            : {})}
        />
      </main>
    );
  }
  return (
    <MachineProvider machine={machine} client={pane.client} ui={pane.ui}>
      <Synced machine={machine} home={home} client={pane.client}>
        <div className={c.pane} data-machine-pane={machine}>
          <Main />
          <RightPanel />
          {/* Its menus and sheets act on it: drawn here, with its client. */}
          <MenuSheet />
          <NativeSheets />
        </div>
      </Synced>
    </MachineProvider>
  );
}

/**
 * The window's view and the computer's screen kept in step both ways: the window going to one of
 * its pages (Back, a row) shows it there; the pane going somewhere (a link, a tab) is a step in
 * the window's history. Drawn once the computer's screen shows the page asked for.
 */
function Synced({ machine, home, client, children }: { machine: string; home: SocketClient; client: SocketClient; children: ReactNode }) {
  // The window's own view (this provider's useApp is the computer's).
  const windowView = useSyncExternalStore(home.store.subscribe, () => home.store.getState().view);
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    const want = paneViewFor(machine, windowView, client.store.getState().view);
    if (want) client.store.dispatch({ type: 'view', view: want });
    setShown(true);
  }, [machine, windowView, client]);
  // Shown: here while this window is (in front or not); left: in the background again.
  useLayoutEffect(() => {
    const follow = (): void => client.store.dispatch({ type: 'away', away: home.store.getScreen().away });
    follow();
    const off = home.store.subscribe(follow);
    return () => {
      off();
      // Only once the window has gone elsewhere (a redraw that keeps it here leaves it as it is).
      if (paneOf(home.store.getState().view).machine !== machine) background(client);
    };
  }, [machine, home, client]);
  useLayoutEffect(
    () =>
      client.store.subscribe(() => {
        const now = home.store.getState().view;
        // Only while the window is on this computer: a late change there never pulls you back.
        if (paneOf(now).machine !== machine) return;
        const next = windowViewFor(machine, now, client.store.getState().view);
        if (next) home.store.dispatch({ type: 'view', view: next });
      }),
    [machine, home, client],
  );
  return shown ? <>{children}</> : null;
}
