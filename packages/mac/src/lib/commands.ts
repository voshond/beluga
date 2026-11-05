import { type AppState, channelOf, shownChannel } from '@beluga/core/store.js';
import { isPlanHome } from '@beluga/core/plans/model.js';
import { runId } from '@beluga/shared/terminal-keys.js';
import { isRunning } from '@beluga/ui/format.js';
import { type WorkspaceAction, findWorkspace, workspaceButtons } from '@beluga/ui/workspace-models.js';
import { worktreeOrigin } from '@beluga/workspaces/origin.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import type { Actions } from './actions.js';
import type { UiStore } from './beluga.js';
import { convoModeOf, terminalCapable, toggledMode, withConvoMode } from './convo-mode.js';
import { getPrefs, setPrefs } from './prefs.js';
import { SETTINGS_FIND_EVENT } from './settings-search.js';

/**
 * The window's commands that the menu bar, the keyboard and the buttons share: what each does,
 * whether it can run right now (and why not), so a menu item is greyed out exactly when its
 * button is, and a shortcut pressed at the wrong moment says why instead of doing nothing.
 */

export interface CommandCtx {
  readonly client: SocketClient;
  readonly ui: UiStore;
  readonly actions: Actions;
}

export interface CommandState {
  readonly enabled: boolean;
  /** Why it can't run (said in a toast when its shortcut is pressed anyway). */
  readonly why?: string;
  /** For a toggle (Plan First): on or off. */
  readonly checked?: boolean;
  /** A label that changes with the state (Run / Stop Running). */
  readonly label?: string;
}

export const COMMAND_IDS = [
  'conv-stop',
  'conv-plan',
  'conv-find',
  'conv-find-next',
  'conv-find-prev',
  'conv-copy',
  'conv-clear',
  'conv-terminal',
  'ws-commit',
  'ws-pr',
  'ws-merge',
  'ws-run',
  'ws-review',
  'ws-finder',
  'ws-fork',
  'ws-archive',
  'ws-next',
  'ws-prev',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

/** The workspace action behind each workspace command (its toolbar button). */
const WS_ACTION: Partial<Record<CommandId, WorkspaceAction>> = {
  'ws-commit': 'commit',
  'ws-pr': 'pr',
  'ws-merge': 'merge',
  'ws-run': 'run',
  'ws-review': 'review_claude',
  'ws-finder': 'finder',
  'ws-fork': 'fork',
  'ws-archive': 'archive',
};

const OFF = (why: string): CommandState => ({ enabled: false, why });
const ON: CommandState = { enabled: true };

/** The workspace on screen (any of its tabs). */
export function currentWorkspace(state: AppState): Workspace | undefined {
  return state.view.kind === 'workspace' ? findWorkspace(state.projects, state.view.id) : undefined;
}

/** The conversation on screen, if one is (a workspace counts on any of its tabs). */
export function currentChannel(state: AppState): string | undefined {
  // A conversation with friends (the Beluga network) has no Claude to stop, plan or clear.
  if (state.view.kind === 'conversation') return undefined;
  return state.view.kind === 'workspace' ? channelOf(state.view) : shownChannel(state.view);
}

/** Your Claude is working in this conversation right now (not just queued or waiting for approval). */
export function claudeWorkingIn(state: AppState, channel: string): boolean {
  return state.log.some((l) => l.type === 'agent' && l.channel === channel && l.owner === state.selfId && isRunning(l.status) && l.status !== 'queued' && l.status !== 'awaiting_approval');
}

/** The conversation itself is showing (not a workspace's Files, Diff or Terminal tab). */
const chatShowing = (state: AppState): boolean => {
  const v = state.view;
  return v.kind === 'room' || v.kind === 'assistant' || v.kind === 'draft' || v.kind === 'draft_worktree' || ((v.kind === 'workspace' || v.kind === 'shared') && v.tab === 'chat');
};

/** A workspace's run script is running. */
export const runRunning = (state: AppState, wsId: string): boolean => runId(wsId) in state.terminals && !(runId(wsId) in state.termExits);

/** Every live workspace in the sidebar's order: chats first, then each project's own worktrees. */
export function workspaceOrder(state: AppState): Workspace[] {
  const visible = (w: Workspace): boolean => !w.archived && worktreeOrigin(w) !== 'agent';
  const chats = state.projects.filter((p) => !p.root);
  const grouped = new Set(state.projectGroups.flatMap((g) => g.projects));
  const loose = state.projects.filter((p) => p.root && !grouped.has(p.root));
  const inGroups = state.projectGroups.flatMap((g) => state.projects.filter((p) => p.root && g.projects.includes(p.root)));
  return [...chats, ...loose, ...inGroups].flatMap((p) => p.workspaces.filter(visible));
}

/** Whether a command can run now, and why not. */
export function commandState(state: AppState, id: CommandId): CommandState {
  const channel = currentChannel(state);
  const ws = currentWorkspace(state);
  switch (id) {
    case 'conv-stop':
      if (!channel || channel === 'draft') return OFF('Open a conversation where your agent is working');
      return claudeWorkingIn(state, channel) ? ON : OFF("Your agent isn't working here");
    case 'conv-plan':
      if (!channel || channel === 'draft' || state.view.kind === 'shared') return OFF('Plan mode is for your own conversations');
      if (isPlanHome(state.plans, channel)) return OFF('A plan’s own conversation has no plan mode: the plan is its plan');
      return { enabled: true, checked: state.planMode[channel] === true };
    case 'conv-find':
    case 'conv-find-next':
    case 'conv-find-prev':
      return chatShowing(state) && state.view.kind !== 'draft' && state.view.kind !== 'draft_worktree' ? ON : OFF('Open a conversation to find in it');
    case 'conv-terminal': {
      const w = currentWorkspace(state);
      if (!getPrefs().termView) return OFF('Turn on the terminal view in Settings › Terminal');
      return w && terminalCapable(state, w.id) ? { enabled: true, checked: convoModeOf(getPrefs().convoModes, getPrefs().convoDefault, w.id) !== 'chat' } : OFF('Open a worktree or a chat on Claude Code to see it as a terminal');
    }
    case 'conv-copy':
      return state.log.some((l) => l.type === 'agent' && l.status === 'done') ? ON : OFF('No answer to copy yet');
    case 'conv-clear':
      return channel && channel !== 'draft' && state.view.kind !== 'shared' ? ON : OFF('Open a conversation to clear it');
    case 'ws-next':
    case 'ws-prev':
      return workspaceOrder(state).length ? ON : OFF('No workspaces yet');
    default: {
      const action = WS_ACTION[id];
      if (!ws || !action) return OFF('Open a workspace first');
      const button = workspaceButtons(state, ws).find((b) => b.action === action || (action === 'merge' && b.action === 'merge_claude'));
      if (id === 'ws-run') {
        if (runRunning(state, ws.id)) return { enabled: true, label: 'Stop Running' };
        if (!button) return { ...OFF(`${ws.name} has no run script yet (Terminal tab › Run)`), label: 'Run' };
        return { enabled: true, label: 'Run' };
      }
      if (!button) return OFF(ws.kind === 'chat' ? `Not for a chat` : ws.kind === 'main' ? 'Not for the main folder' : 'Not available here');
      return button.disabled ? OFF(button.hint) : ON;
    }
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Send now, for a message you steered in that Claude hasn't read yet (BLG-54): its step stops and
 * the conversation goes on from your message. The message's Send now and the box's ⇧⌥↩.
 */
export function sendSteerNow(client: SocketClient, request: string): void {
  client.api.host.steerNow(request).catch((err: unknown) => client.store.dispatch({ type: 'toast', text: err instanceof Error ? err.message : String(err), level: 'error' }));
}

/**
 * Stop your Claude in one conversation. Your messages that were waiting there come back into
 * the box (ahead of anything you're typing), so nothing you wrote is lost.
 */
export function stopClaude({ client, ui }: CommandCtx, channel: string): void {
  client.api.host.stopRun(channel).then(
    ({ returned }) => {
      if (!returned.length) return;
      const state = client.store.getState();
      // In a group room only a mention reaches your Claude.
      const toClaude = (p: string): string => (channel === 'room' && state.peers.length > 1 && !p.startsWith('@') ? `@claude ${p}` : p);
      const current = ui.get().buffer.trim();
      const buffer = [...returned.map(toClaude), current].filter(Boolean).join('\n');
      ui.patch({ buffer, cursor: buffer.length });
      document.dispatchEvent(new CustomEvent('beluga:focus-composer'));
    },
    (err: unknown) => client.store.dispatch({ type: 'toast', text: `Couldn't stop the agent: ${errorText(err)}`, level: 'error' }),
  );
}

/** Go to the next (or previous) workspace in the sidebar's order. */
function stepWorkspace({ actions, client }: CommandCtx, delta: 1 | -1): void {
  const state = client.store.getState();
  const list = workspaceOrder(state);
  if (!list.length) return;
  const at = state.view.kind === 'workspace' ? list.findIndex((w) => w.id === (state.view as { id: string }).id) : -1;
  const next = at < 0 ? (delta > 0 ? list[0] : list[list.length - 1]) : list[(at + delta + list.length) % list.length];
  if (next) actions.run({ type: 'open_ws', id: next.id });
}

// A shortcut and its menu item can both see one key press; run it once.
const lastRun = new Map<CommandId, number>();
const ONCE_MS = 150;

/** Run a command (from the menu bar, a shortcut or a button); when it can't run, say why. */
export function runCommand(ctx: CommandCtx, id: CommandId): void {
  const now = Date.now();
  if (now - (lastRun.get(id) ?? 0) < ONCE_MS) return;
  lastRun.set(id, now);
  const { client, ui, actions } = ctx;
  // Find… in Settings searches its settings (BLG-740), not the conversation behind it.
  if (id === 'conv-find' && ui.get().settings) {
    document.dispatchEvent(new CustomEvent(SETTINGS_FIND_EVENT));
    return;
  }
  const state = client.store.getState();
  const st = commandState(state, id);
  if (!st.enabled) {
    client.store.dispatch({ type: 'toast', text: st.why ?? 'Not available right now', level: 'info' });
    return;
  }
  const channel = currentChannel(state);
  const ws = currentWorkspace(state);
  switch (id) {
    case 'conv-stop':
      if (channel) stopClaude(ctx, channel);
      return;
    case 'conv-plan':
      if (channel) void client.api.session.setPlanMode(channel, !st.checked);
      return;
    case 'conv-find':
      document.dispatchEvent(new CustomEvent('beluga:find'));
      return;
    case 'conv-find-next':
    case 'conv-find-prev':
      document.dispatchEvent(new CustomEvent('beluga:find-step', { detail: id === 'conv-find-next' ? 1 : -1 }));
      return;
    case 'conv-terminal':
      // Chat ⇄ Terminal (Both goes back to the chat), BLG-534.
      if (ws) setPrefs({ convoModes: withConvoMode(getPrefs().convoModes, ws.id, toggledMode(convoModeOf(getPrefs().convoModes, getPrefs().convoDefault, ws.id))) });
      return;
    case 'conv-copy':
      void client.api.session.copyLastAnswer();
      return;
    case 'conv-clear':
      if (channel) ui.openMenu({ kind: 'clear', channel, host: state.isHost });
      return;
    case 'ws-next':
    case 'ws-prev':
      stepWorkspace(ctx, id === 'ws-next' ? 1 : -1);
      return;
    default: {
      const action = WS_ACTION[id];
      if (!ws || !action) return;
      if (id === 'ws-run' && runRunning(state, ws.id)) return actions.run({ type: 'ws', id: ws.id, action: 'stop_run' });
      // A conflict turns Merge into "Solve conflict" (Claude finishes the merge).
      const solve = action === 'merge' && state.conflicts[ws.id]?.length;
      // Part of a plan: merging (or solving) by hand asks first, in actions.run (lib/plan-merge.ts).
      actions.run({ type: 'ws', id: ws.id, action: solve ? 'merge_claude' : action });
    }
  }
}
