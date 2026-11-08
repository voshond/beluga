import { type AppState, channelOf, peerName } from '../core/store.js';
import { isBelugaCommand } from '../core/commands.js';
import { parseInput } from '../core/mentions.js';
import type { BelugaClient } from '../ipc/client.js';
import { builtInInstead } from '../shared/skills.js';
import { answerTyped } from './collab-actions.js';
import type { UiState } from './keymap.js';
import type { UiAction } from './workspace-models.js';

export interface SubmitContext {
  readonly client: BelugaClient;
  /** The screen's latest UI state (what the box is asking for, a plan open full screen). */
  readonly ui: () => Pick<UiState, 'pending' | 'planFull'>;
  readonly patchUi: (patch: Partial<UiState>) => void;
  readonly runUiAction: (action: UiAction) => void;
  /** Turn attachment chips into links before sending (each screen attaches its own way). */
  readonly expand?: (text: string) => string;
  /** Whether a message sent in `channel` ('draft': a new one) opens its agent's terminal on it, as the screen shows it (BLG-553). */
  readonly toTerminal?: (channel: string) => boolean;
}

/**
 * How a new worktree starts, from the mode picked on its page: Plan with Tasks plans in the chat
 * (never its terminal, and no plan mode: a plan's own conversation has none).
 */
export function worktreeMode(picked: { readonly terminal: boolean; readonly plan: boolean; readonly tasks: boolean }): { terminal?: true; plan?: true; tasks?: true } {
  if (picked.tasks) return { tasks: true };
  return { ...(picked.terminal ? { terminal: true as const } : {}), ...(picked.plan ? { plan: true as const } : {}) };
}

/**
 * Send what was typed in the box, wherever it belongs: an answer to Claude's question, a
 * command for a shared workspace's shell, the first message of a new chat or worktree, a name
 * the box asked for, a search, or a message in the conversation on screen.
 */
export function submitTyped(c: SubmitContext, typed: string, urgent = false): void {
  const { client, patchUi } = c;
  const { api, store } = client;
  const toast = (text: string): void => store.dispatch({ type: 'toast', text, level: 'warn' });
  const latest: AppState = store.getState();
  const text = c.expand ? c.expand(typed) : typed;
  const ui = c.ui();
  // While Claude waits on a question in this conversation, what you type here is your answer.
  const question = latest.questions[0];
  if (question && (question.channel === channelOf(latest.view) || ui.planFull === question.qid) && !text.startsWith('/')) {
    answerTyped(client, question, text);
    patchUi({ planFull: undefined, planScroll: 0 });
    return;
  }
  // A shared workspace's Terminal tab: what you type is a command for its read-only shell.
  if (latest.view.kind === 'shared' && latest.view.tab === 'terminal' && !text.startsWith('/')) {
    void api.shell.run(latest.view.id, text);
    patchUi({ chatScroll: 0 });
    return;
  }
  const terminal = c.toTerminal?.(channelOf(latest.view)) ?? false;
  if (latest.view.kind === 'draft') {
    const view = latest.view;
    const plan = latest.planMode.draft === true;
    const start = (prompt: string): void => {
      void (terminal || plan ? api.workspaces.startChat(view.projectId, prompt, view.dir ?? null, { ...(terminal ? { terminal } : {}), ...(plan ? { plan } : {}) }) : api.workspaces.startChat(view.projectId, prompt, view.dir));
    };
    const command = text.startsWith('/') ? parseInput(text, latest.selfId, latest.peers) : undefined;
    if (!command || command.kind === 'chat') return start(command?.kind === 'chat' ? command.text : text);
    if (command.kind === 'command' && !isBelugaCommand(command.name)) {
      if (!builtInInstead(command.name)) return start(text);
      const dir = view.projectId === 'chats' ? view.dir : latest.projects.find((p) => p.id === view.projectId)?.root;
      const explain = (): void => {
        void api.session.submit(text, { channel: 'draft', urgent });
      };
      void api.claudeCode.skills('draft', dir || undefined).then(
        (skills) => skills.some((skill) => skill.name.toLowerCase() === command.name) ? start(text) : explain(),
        explain,
      );
      return;
    }
  }
  if (latest.view.kind === 'draft_worktree' && !text.startsWith('/')) {
    const mode = worktreeMode({ terminal, plan: latest.planMode.draft === true, tasks: false });
    void api.workspaces.startWorktree(latest.view.projectId, text, Object.keys(mode).length ? mode : undefined);
    return;
  }
  const pending = ui.pending;
  if (pending?.kind === 'peer_run' && pending.peerId) {
    if (!text.trim()) return toast('Type a command first, or Esc to cancel');
    patchUi({ pending: undefined });
    void api.session.runOnPeerByHand(peerName(latest, pending.peerId), text.trim(), channelOf(latest.view));
    return;
  }
  if (pending) {
    // Only commands may be empty (to clear them); names and tasks need words.
    if (!text.trim() && pending.kind !== 'setup' && pending.kind !== 'run') {
      toast(pending.kind === 'remote' ? 'Describe the task first, or Esc to cancel' : 'Type a name first, or Esc to cancel');
      return;
    }
    patchUi({ pending: undefined });
    if (pending.kind === 'group') void api.workspaces.setGroup(pending.projectId, text);
    else if (pending.kind === 'setup' || pending.kind === 'run') void api.workbench.setScript(pending.projectId, pending.kind, text);
    else if (pending.kind === 'remote' && pending.peerId) void api.remote.requestWorktree(pending.peerId, pending.projectId, text, latest.planMode.room === true);
    else void (pending.kind === 'worktree' ? api.workspaces.newWorktree(pending.projectId, text) : api.workspaces.newChat(pending.projectId, text));
    return;
  }
  // In Search, Enter opens the highlighted result.
  if (latest.view.kind === 'search' && !text.startsWith('/')) {
    if (latest.search.hits.length) c.runUiAction({ type: 'search_hit', index: latest.search.cursor });
    return;
  }
  void api.session.submit(text, { channel: channelOf(latest.view), urgent, ...(terminal && !text.startsWith('/') ? { terminal } : {}) });
}
