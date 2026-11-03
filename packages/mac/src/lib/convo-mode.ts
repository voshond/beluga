import type { AppState, LogItem } from '../../../../src/core/store.js';
import { activityOf } from '../../../../src/ui/workspace-models.js';
import { defaultAgentOf } from '../../../../src/protocol.js';
import { runtimeOf } from '../../../../src/shared/agent-picker.js';
import { runtimeHas } from '../../../../src/shared/runtime-fallbacks.js';

/**
 * How a conversation shows in the middle of the window (BLG-534): the chat, the agent's own
 * terminal app on the same conversation, or both side by side. Remembered per conversation;
 * one you haven't switched opens your default. Pure: the prefs keep it (lib/prefs.ts).
 */

export type ConvoMode = 'chat' | 'terminal' | 'both';

export const CONVO_MODES: readonly ConvoMode[] = ['chat', 'terminal', 'both'];

/** Conversations remembered (the oldest switch is forgotten past this). */
const KEEP = 200;

export const isConvoMode = (v: unknown): v is ConvoMode => typeof v === 'string' && (CONVO_MODES as readonly string[]).includes(v);

/** A conversation's mode: the one you picked there, else your default. */
/** How a conversation shows given your settings: always the chat while the terminal view is off. */
export function shownMode(prefs: { readonly termView: boolean; readonly convoModes: Readonly<Record<string, ConvoMode>>; readonly convoDefault: ConvoMode }, wsId: string): ConvoMode {
  return prefs.termView ? convoModeOf(prefs.convoModes, prefs.convoDefault, wsId) : 'chat';
}

export function convoModeOf(modes: Readonly<Record<string, ConvoMode>>, fallback: ConvoMode, wsId: string): ConvoMode {
  const m = modes[wsId];
  return isConvoMode(m) ? m : fallback;
}

/** The modes with this conversation's switched (the newest last, so the oldest goes first). */
export function withConvoMode(modes: Readonly<Record<string, ConvoMode>>, wsId: string, mode: ConvoMode): Record<string, ConvoMode> {
  const { [wsId]: _was, ...rest } = modes;
  const entries = [...Object.entries(rest).filter(([, m]) => isConvoMode(m)), [wsId, mode] as const];
  return Object.fromEntries(entries.slice(-KEEP));
}

/** What the middle shows besides a mode (BLG-553): the chat while the terminal waits on a turn there, or before it has one. */
export type CenterShows = ConvoMode | 'waiting' | 'fresh';

/** Where a conversation is, for what the middle shows. */
export interface ConvoNow {
  /** A turn is running (or queued) in the chat. */
  readonly turnRunning: boolean;
  /** The agent's terminal is driving it now. */
  readonly driving: boolean;
  /** Its agent has had a turn here (in the chat or the terminal). */
  readonly started: boolean;
  /** You picked its mode yourself (the header's switch, ⇧⌘T), rather than it being your default. */
  readonly picked: boolean;
}

/**
 * What the middle shows for a mode (BLG-553). A conversation seen as its terminal by default
 * starts as the chat ('fresh'): nothing is launched until you send your first message, which then
 * opens the terminal on it (picking Terminal for it yourself opens it at once). The terminal can't open over a turn running in the chat, so until that ends the
 * chat shows ('waiting'), with a banner. A terminal already driving stays.
 */
export function centerShows(mode: ConvoMode, now: ConvoNow): CenterShows {
  if (mode === 'chat' || now.driving) return mode;
  if (now.turnRunning) return 'waiting';
  return now.started || now.picked ? mode : 'fresh';
}

const turnsIndex = new WeakMap<readonly LogItem[], ReadonlySet<string>>();

/** Whether a conversation has had its agent's turn (cached per log, as the log only grows by copies). */
export function hasAgentTurn(log: readonly LogItem[], channel: string): boolean {
  let seen = turnsIndex.get(log);
  if (!seen) {
    seen = new Set(log.filter((l) => l.type === 'agent').map((l) => l.channel));
    turnsIndex.set(log, seen);
  }
  return seen.has(channel);
}

/** What you need to know about the prefs to tell where a message goes. */
type ModePrefs = Parameters<typeof shownMode>[0];

/**
 * Whether a message sent now opens the agent's terminal on it (BLG-553): the conversation is
 * seen as its terminal and hasn't started ('fresh'). `draft`: a new chat or worktree, made with
 * this message (on `runtime`, the agent picked for it).
 */
export function sendsToTerminal(state: AppState, prefs: ModePrefs, channel: string, runtime?: string): boolean {
  if (!prefs.termView) return false;
  if (channel === 'draft') return prefs.convoDefault !== 'chat' && runtimeHas(runtime ?? defaultAgentOf(state.self).runtime, 'terminal');
  if (!channel.startsWith('ws:')) return false;
  const wsId = channel.slice(3);
  if (!terminalCapable(state, wsId)) return false;
  const now = { turnRunning: activityOf(state.log, channel).running, driving: Boolean(state.agentTerms[wsId]), started: hasAgentTurn(state.log, channel), picked: isConvoMode(prefs.convoModes[wsId]) };
  return centerShows(shownMode(prefs, wsId), now) === 'fresh';
}

/** The next mode for the Chat ⇄ Terminal shortcut: Both and Terminal go to Chat; Chat goes to Terminal. */
export const toggledMode = (mode: ConvoMode): ConvoMode => (mode === 'chat' ? 'terminal' : 'chat');

/** Bounds of the chat's share in Both. */
export const BOTH_MIN = 0.25;
export const BOTH_MAX = 0.6;
export const clampBoth = (share: number): number => Math.min(BOTH_MAX, Math.max(BOTH_MIN, Number.isFinite(share) ? share : 0.38));

/** Bounds of the visuals panel beside the terminal. */
export const VISUALS_MIN = 360;
export const clampVisuals = (width: number, room: number): number => Math.round(Math.min(Math.max(VISUALS_MIN, width), Math.max(VISUALS_MIN, room * 0.62)));

/**
 * Whether a workspace's conversation can show as a terminal: yours, made, not a project's main
 * checkout, and on Claude Code (a local model runs in it too). Codex's and OpenCode's stay in the
 * chat (runtime-fallbacks.ts `terminal`).
 */
export function terminalCapable(state: AppState, wsId: string | undefined): boolean {
  const ws = wsId ? state.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId) : undefined;
  if (!ws || ws.archived || ws.kind === 'main' || (ws.kind === 'worktree' && ws.external)) return false;
  return runtimeHas(runtimeOf(state, `ws:${ws.id}`, defaultAgentOf(state.self).runtime), 'terminal');
}
