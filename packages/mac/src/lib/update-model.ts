import type { LogItem, View } from '../../../../src/core/store.js';
import { isRunning } from '../../../../src/ui/format.js';

/**
 * Beluga's own updates, as the window shows them: what the app shell (src-tauri/src/updater.rs)
 * reports, and the words for it. Pure, so tests/mac-updates.test.ts covers it.
 */

export type UpdateMode = 'idle' | 'ask' | 'off';
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'current' | 'error';
export type UpdateChoice = 'idle' | 'quit';
export type UpdateBlocker = 'claude' | 'terminal' | 'room' | 'you';

export interface UpdateState {
  /** The version running now. */
  readonly current: string;
  readonly mode: UpdateMode;
  readonly phase: UpdatePhase;
  /** When Beluga last looked successfully (ms since the epoch). */
  readonly lastCheck?: number | null;
  /** A downloaded update, ready to install. */
  /** `ipc` (BLG-777): the app protocol the new version speaks, when its release says. */
  readonly available?: { readonly version: string; readonly notes?: string | null; readonly date?: string | null; readonly ipc?: number | null } | null;
  /** 0–1 while downloading. */
  readonly progress?: number | null;
  /** When the downloaded update goes in: when you're idle, or when you quit. */
  readonly choice?: UpdateChoice | null;
  readonly error?: string | null;
  /** What "Update When Idle" still waits for. */
  readonly waitingOn: readonly UpdateBlocker[];
  /** Just updated to this (shown once: "What's new"). */
  readonly news?: { readonly version: string; readonly notes?: string | null } | null;
}

/**
 * Until the app shell answers: a new install's mode (updater.rs › NEW_INSTALL_MODE, BLG-99).
 * The shell's saved mode replaces it at once, so earlier installs keep theirs.
 */
export const INITIAL_UPDATE_STATE: UpdateState = { current: '', mode: 'idle', phase: 'idle', waitingOn: [] };

/** Settings' two switches, as the mode the app shell keeps: "Update automatically" and "Check for updates". */
export interface UpdateSwitches {
  readonly auto: boolean;
  readonly check: boolean;
}

export const switchesOf = (mode: UpdateMode): UpdateSwitches => ({ auto: mode === 'idle', check: mode !== 'off' });

/** Updating automatically needs looking; not looking can't update automatically. */
export function modeOf(next: Partial<UpdateSwitches>, now: UpdateMode): UpdateMode {
  const was = switchesOf(now);
  const auto = next.auto ?? (next.check === false ? false : was.auto);
  const check = next.check ?? (next.auto === true ? true : was.check);
  if (!check) return 'off';
  return auto ? 'idle' : 'ask';
}

/** "0.5" for 0.5.0, "0.4.1" otherwise: how people say a version. */
export function shortVersion(version: string): string {
  return version.replace(/^v/, '').replace(/^(\d+\.\d+)\.0$/, '$1');
}

/** Whether there's something to show in the sidebar: a downloaded update, or what just changed. */
export function pillOf(state: UpdateState): { readonly label: string; readonly kind: 'ready' | 'news' } | undefined {
  if (state.available) {
    return { label: state.phase === 'installing' ? 'Updating Beluga…' : `Beluga ${shortVersion(state.available.version)} is ready`, kind: 'ready' };
  }
  if (state.news) return { label: `Updated to ${shortVersion(state.news.version)} · What’s new`, kind: 'news' };
  return undefined;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** "Never", "Just now", "12 minutes ago", "Today at 9:41", "Yesterday at 18:02", "3 Oct". */
export function lastCheckedLabel(lastCheck: number | null | undefined, now: number = Date.now(), locale?: string): string {
  if (!lastCheck) return 'Never';
  const ago = now - lastCheck;
  if (ago < MINUTE) return 'Just now';
  if (ago < 60 * MINUTE) {
    const m = Math.floor(ago / MINUTE);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  const at = new Date(lastCheck);
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (lastCheck >= startOfToday) return `Today at ${time}`;
  if (lastCheck >= startOfToday - DAY) return `Yesterday at ${time}`;
  return at.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

const BLOCKER_WORDS: Record<UpdateBlocker, string> = {
  claude: 'your agent to finish',
  terminal: 'programs in your terminals to finish',
  room: 'friends to leave your room (or you to leave theirs)',
  you: 'you to step away for 10 minutes',
};

/** "Installs when you step away", or what it still waits for. */
export function idleLine(waitingOn: readonly UpdateBlocker[]): string {
  if (!waitingOn.length) return 'Installs as soon as you step away. Beluga reopens in the background.';
  const words = waitingOn.map((b) => BLOCKER_WORDS[b]);
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
  return `Waiting for ${list}.`;
}

/** What the Settings row says about updates right now. */
export function statusLine(state: UpdateState): string {
  switch (state.phase) {
    case 'checking':
      return 'Checking…';
    case 'downloading':
      return `Downloading${state.progress ? ` · ${Math.round(state.progress * 100)}%` : '…'}`;
    case 'installing':
      return 'Installing…';
    case 'error':
      return state.error ?? 'Couldn’t check for updates.';
    default:
      if (state.available) return `Beluga ${shortVersion(state.available.version)} is ready${state.choice === 'idle' ? ' · installs when you’re idle' : ' · installs when you quit'}`;
      return state.phase === 'current' ? 'Beluga is up to date.' : '';
  }
}

/** What the app shell needs to know before installing quietly (update_rules.rs › Activity). */
export interface UpdateActivity {
  readonly claude: number;
  readonly guests: number;
  readonly joined: boolean;
}

interface ActivitySource {
  readonly log: readonly LogItem[];
  readonly peers: ReadonlyArray<{ readonly peerId: string }>;
  readonly selfId: string;
  readonly isHost: boolean;
}

export function activityOf(st: ActivitySource): UpdateActivity {
  const claude = st.log.filter((l) => l.type === 'agent' && l.owner === st.selfId && isRunning(l.status)).length;
  const guests = st.peers.filter((p) => p.peerId !== st.selfId).length;
  return { claude, guests, joined: Boolean(st.selfId) && !st.isHost };
}

/** Where you were before Restart Now, kept for the relaunch (a few minutes at most). */
export interface SavedPlace {
  readonly view: View;
  readonly at: number;
}

export const PLACE_TTL_MS = 10 * MINUTE;

type PlaceAction = { readonly type: 'open_ws'; readonly id: string; readonly tab: 'chat' | 'files' | 'review' | 'terminal' } | { readonly type: 'view'; readonly view: View };

interface PlaceSource {
  readonly projects: ReadonlyArray<{ readonly id: string; readonly workspaces: ReadonlyArray<{ readonly id: string }> }>;
}

/** How to go back there, if it's still there (and recent). */
export function placeAction(saved: SavedPlace | undefined, st: PlaceSource, now: number = Date.now()): PlaceAction | undefined {
  if (!saved || now - saved.at > PLACE_TTL_MS || now < saved.at) return undefined;
  const v = saved.view;
  switch (v.kind) {
    case 'workspace':
      return st.projects.some((p) => p.workspaces.some((w) => w.id === v.id)) ? { type: 'open_ws', id: v.id, tab: v.tab } : undefined;
    case 'project':
      return st.projects.some((p) => p.id === v.id) ? { type: 'view', view: v } : undefined;
    case 'room':
    case 'files':
    case 'overview':
    case 'search':
    case 'usage':
    case 'terminal':
    case 'conversation':
      return { type: 'view', view: v };
    default:
      return undefined;
  }
}
