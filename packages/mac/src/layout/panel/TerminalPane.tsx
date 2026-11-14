import { useEffect, useRef } from 'react';
import { githubId, isOwnShell, runId, setupId, shellId, terminalLabel } from '@beluga/shared/terminal-keys.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { ActionsDropdown, type ActionItem } from '../../components/SpecMenu.js';
import { Button, Dot, Empty, IconButton } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useApi, useApp, useBeluga, useUi } from '../../lib/beluga.js';
import { closeFocus, moveTerminal, openFocus, usePanelRuntime } from '../../lib/panel.js';
import { setPrefs, usePrefs } from '../../lib/prefs.js';
import { useGlobalShells } from '../../lib/shells.js';
import { chordLabel } from '../../lib/shortcuts-model.js';
import { takeRuns } from '../../lib/term-run-queue.js';
import { claimShell, extraShells, pruneShells, releaseShell, useShellOwners } from '../../lib/ws-shells.js';
import { EnvStale, NoShells, ShellTabs, useEnvStale } from '../../views/TerminalView.js';
import { TerminalTab } from '../../views/TerminalTab.js';
import { Xterm, type XtermProps } from '../../views/Xterm.js';
import { SshMenu } from '../../views/SshMenu.js';
import t from '../../views/terminal.module.css';
import s from './panel.module.css';

/** How recently ⌘J must have asked for the keyboard for a terminal that just appeared to take it. */
const FOCUS_WINDOW_MS = 800;

/** Run in a chat's code block types into the terminal that's showing here (lib/term-run.ts). */
const TAKES_RUNS: NonNullable<XtermProps['extend']> = (_term, tools) => takeRuns(tools.write);

interface Tabbed {
  readonly key: string | undefined;
  readonly tabs: ReadonlyArray<{ key: string; label: string; running: boolean; exit?: number | null; closable: boolean; renamable: boolean }>;
  readonly start: (size: { cols: number; rows: number }) => void;
  readonly restart?: () => void;
  readonly pick: (key: string) => void;
  readonly add: () => void;
  readonly openSsh?: (host: string) => void;
  readonly close: (key: string) => void;
}

/** A workspace's terminals: its shell, setup and run while they exist, and shells you added with +. */
function useWorkspaceTerminals(wsId: string): Tabbed {
  const api = useApi();
  const { ui } = useBeluga();
  const terminals = useApp((st) => st.terminals);
  const exits = useApp((st) => st.termExits);
  const names = useApp((st) => st.termNames);
  const projects = useApp((st) => st.projects);
  const picked = useUi((u) => u.termKey);
  const owners = useShellOwners();
  const ws = findWorkspace(projects, wsId);
  useEffect(() => pruneShells(terminals), [terminals]);
  const extra = extraShells(owners, wsId, terminals, picked);
  const own = [shellId(wsId), setupId(wsId), runId(wsId), githubId(wsId)].filter((k) => k in terminals || k === shellId(wsId));
  const keys = [...own, ...extra];
  const key = picked && keys.includes(picked) && (picked in terminals || extra.includes(picked)) ? picked : shellId(wsId);
  const isExtra = (k: string): boolean => extra.includes(k);
  return {
    key,
    tabs: keys.map((k) => ({ key: k, label: terminalLabel(k, names), running: k in terminals && !(k in exits), ...(k in exits ? { exit: exits[k] } : {}), closable: isExtra(k), renamable: k === shellId(wsId) || isExtra(k) })),
    start: (size) => {
      if (key === shellId(wsId)) void api.terminals.shell(wsId, size);
      else if (isExtra(key) && ws) void api.terminals.global(key, ws.path, size);
    },
    ...(key === shellId(wsId) ? { restart: () => void api.terminals.shell(wsId) } : isExtra(key) && ws ? { restart: () => void api.terminals.global(key, ws.path) } : {}),
    pick: (k) => ui.patch({ termKey: k }),
    add: () => ui.patch({ termKey: claimShell(wsId, terminals) }),
    close: (k) => {
      if (k === key) ui.patch({ termKey: shellId(wsId) });
      releaseShell(k);
      void api.terminals.close(k);
    },
  };
}

/** The window's Run and Setup for a workspace, small enough for the terminal's bar. */
function WorkspaceScripts({ wsId }: { wsId: string }) {
  const actions = useActions();
  const project = useApp((st) => st.projects.find((p) => p.workspaces.some((w) => w.id === wsId)));
  const runOn = useApp((st) => runId(wsId) in st.terminals && !(runId(wsId) in st.termExits));
  if (!project?.scripts?.run) return null;
  return runOn ? (
    <IconButton icon="stop" label="Stop running" keys={chordLabel('Cmd+R')} onClick={() => actions.run({ type: 'ws', id: wsId, action: 'stop_run' })} />
  ) : (
    <IconButton icon="play" label={`Run · ${project.scripts.run.command}`} keys={chordLabel('Cmd+R')} onClick={() => actions.run({ type: 'ws', id: wsId, action: 'run' })} />
  );
}

/** The terminal's ⋯: where ⌘J shows it, moving it there now, the full-size view, the project's commands. */
function useMenuItems(where: 'drawer' | 'panel', wsId: string | undefined): ActionItem[] {
  const { client, ui } = useBeluga();
  const actions = useActions();
  const prefs = usePrefs();
  const project = useApp((st) => (wsId ? st.projects.find((p) => p.workspaces.some((w) => w.id === wsId)) : undefined));
  const other = where === 'drawer' ? 'panel' : 'drawer';
  return [
    { label: other === 'panel' ? 'Move to the Right Panel' : 'Move to the Bottom Drawer', icon: other === 'panel' ? 'panelRight' : 'panelBottom', onSelect: () => moveTerminal(client.store.getState(), other) },
    {
      label: `${chordLabel('Cmd+J')} Opens the Terminal`,
      separate: true,
      onSelect: () => undefined,
      submenu: [
        { label: 'In the Bottom Drawer', checked: prefs.termIn === 'drawer', onSelect: () => setPrefs({ termIn: 'drawer' }) },
        { label: 'In the Right Panel', checked: prefs.termIn === 'panel', onSelect: () => setPrefs({ termIn: 'panel' }) },
      ],
    },
    wsId
      ? { label: 'Show Full Size', icon: 'expand', separate: true, onSelect: () => openFocus('terminal', wsId) }
      : { label: 'Open the Terminal View', icon: 'expand', separate: true, onSelect: () => actions.run({ type: 'view', view: { kind: 'terminal' } }) },
    ...(project?.root ? [{ label: 'Commands…', icon: 'terminal' as const, onSelect: () => ui.openMenu({ kind: 'scripts', projectId: project.id }) }] : []),
    { label: 'Terminal Settings…', icon: 'gear', onSelect: () => ui.patch({ settings: 'terminal' }) },
  ];
}

/** Workspace terminals and your own shells, as one shape. */
function useTabbed(wsId: string | undefined): Tabbed {
  const ws = useWorkspaceTerminals(wsId ?? '');
  const picked = useUi((u) => u.termKey);
  const shells = useGlobalShells();
  const terminals = useApp((st) => st.terminals);
  const owners = useShellOwners();
  const ownTabs = shells.tabs.map((x) => ({ ...x, closable: true, renamable: true }));
  if (!wsId) {
    const key = shells.key;
    return {
      key,
      tabs: ownTabs,
      start: (size) => key && shells.start(key, size),
      ...(key ? { restart: () => shells.start(key) } : {}),
      pick: shells.pick,
      add: shells.open,
      openSsh: shells.openSsh,
      close: shells.close,
    };
  }
  const unowned = (k: string): boolean => !(k in owners);
  const ownKey = shells.key && shells.key === picked && unowned(picked) ? shells.key : undefined;
  const ownShown = ownTabs.filter((x) => unowned(x.key) && (x.key in terminals || x.key === ownKey));
  if (!ownKey) return { ...ws, tabs: [...ws.tabs, ...ownShown], openSsh: shells.openSsh, close: (k) => (isOwnShell(k) ? shells.close(k) : ws.close(k)) };
  return {
    ...ws,
    key: ownKey,
    tabs: [...ws.tabs, ...ownShown],
    start: (size) => shells.start(ownKey, size),
    restart: () => shells.start(ownKey),
    openSsh: shells.openSsh,
    close: (k) => (isOwnShell(k) ? shells.close(k) : ws.close(k)),
  };
}

/**
 * A terminal in the right panel or in the drawer under the chat: the workspace's shells (or
 * your own) as tabs, + for another, and the terminal itself filling the rest.
 */
export function TerminalPane({ where, onClose }: { where: 'drawer' | 'panel'; onClose?: () => void }) {
  const view = useApp((st) => st.view);
  const exits = useApp((st) => st.termExits);
  const prefs = usePrefs();
  const wsId = view.kind === 'workspace' ? view.id : undefined;
  // On a project's home the terminal is its main folder's, so it starts in the project you're looking at.
  const mainId = useApp((st) => (view.kind === 'project' ? st.projects.find((p) => p.id === view.id)?.workspaces.find((w) => w.kind === 'main')?.id : undefined));
  const tabbed = useTabbed(wsId ?? mainId);
  const items = useMenuItems(where, wsId);
  const focus = usePanelRuntime((r) => (wsId && r.focus?.wsId === wsId ? r.focus.kind : undefined));
  const askedFocus = usePanelRuntime((r) => r.termFocus);
  const body = useRef<HTMLDivElement>(null);
  // ⌘J puts the keyboard here (Run doesn't: you keep typing to Claude).
  // A terminal that's just appearing is made a frame later (Xterm, KLD-68): keep looking until it's there.
  useEffect(() => {
    let id = 0;
    const tryFocus = (): void => {
      if (Date.now() - askedFocus > FOCUS_WINDOW_MS) return;
      const input = body.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
      if (input) input.focus();
      else id = requestAnimationFrame(tryFocus);
    };
    id = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(id);
  }, [askedFocus, tabbed.key]);
  // A terminal shows in one place at a time: the drawer or the full-size view has it.
  const elsewhere = where === 'panel' ? (prefs.drawer ? 'drawer' : focus === 'terminal' ? 'full' : undefined) : focus === 'terminal' ? 'full' : undefined;
  const { key } = tabbed;
  // Restarted with new variables: a fresh terminal on the new program.
  const stale = useEnvStale(key);
  return (
    <section className={s.term} aria-label="Terminal">
      <div className={s.termBar}>
        <div className={s.termTabs} role="tablist" aria-label="Terminals">
          {tabbed.tabs.map((x) => (
            <TerminalTab
              key={x.key}
              termKey={x.key}
              label={x.label}
              on={x.key === key}
              className={s.termTab}
              onClassName={s.termTabOn}
              renamable={x.renamable}
              onPick={() => tabbed.pick(x.key)}
              {...(x.closable ? { onClose: () => tabbed.close(x.key) } : {})}
              before={x.running ? <Dot tone="ok" /> : x.exit !== undefined ? <Dot tone={x.exit === 0 ? 'muted' : 'error'} /> : <Dot tone="muted" />}
              after={x.exit !== undefined && !x.key.startsWith('shell:') ? <span className={t.exit}>{x.exit === 0 ? 'done' : `exit ${x.exit ?? '?'}`}</span> : null}
            />
          ))}
          <IconButton icon="plus" label="New shell" className={s.termAdd} onClick={tabbed.add} />
          {tabbed.openSsh ? <SshMenu onOpen={tabbed.openSsh} className={s.termAdd} /> : null}
        </div>
        {wsId ? <WorkspaceScripts wsId={wsId} /> : null}
        <ActionsDropdown items={items}>
          <IconButton icon="more" label="Terminal options" />
        </ActionsDropdown>
        {onClose ? <IconButton icon="x" label="Close the drawer" keys={chordLabel('Cmd+J')} onClick={onClose} /> : null}
      </div>
      <div ref={body} className={s.termBody}>
        {elsewhere ? (
          <Empty
            icon={elsewhere === 'drawer' ? 'panelBottom' : 'expand'}
            title={elsewhere === 'drawer' ? 'The terminal is in the drawer' : 'The terminal is showing full size'}
            detail={elsewhere === 'drawer' ? 'It shows in one place at a time.' : undefined}
            action={
              <Button size="small" onClick={() => (elsewhere === 'drawer' ? setPrefs({ drawer: false }) : closeFocus())}>
                Show It Here
              </Button>
            }
          />
        ) : key ? (
          <>
            <Xterm key={`${key}:${key in exits ? 'x' : 'live'}${stale ? ':old' : ''}`} termKey={key} start={tabbed.start} focus={false} {...(key in exits ? {} : { extend: TAKES_RUNS })} />
            <EnvStale termKey={key} />
            {key in exits && tabbed.restart ? (
              <div className={t.restart}>
                <Button size="small" onClick={tabbed.restart}>
                  Start It Again
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <NoShells open={tabbed.add} />
        )}
      </div>
    </section>
  );
}
