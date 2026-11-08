import { LONGEST_WAIT_MS } from '../shared/remind.js';
import type { Project, Workspace } from '../workspaces/types.js';
import type { NoticeEvent } from './notify.js';
import type { DomainState } from './store.js';

export interface RemindersDeps {
  readonly projects: () => readonly Project[];
  /** Their time came: clear it (and publish), and remind you of each. */
  readonly due: (list: readonly Workspace[]) => void;
  readonly now?: () => number;
}

/**
 * Remind Me Later's clock (BLG-748): when a conversation's time comes, it's handed to `due`, which
 * clears it from the record (every screen shows what waits there again) and reminds you. One timer,
 * for the next one due. One that came due while Beluga was closed reminds you when it starts.
 */
export class Reminders {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: RemindersDeps) {}

  /** Hand over what's due now, then wait for the next one. Call it whenever a reminder changes. */
  arm(): void {
    this.stop();
    const now = this.deps.now?.() ?? Date.now();
    const later = this.deps.projects().flatMap((p) => p.workspaces.filter((w) => w.remindAt !== undefined && !w.archived));
    const due = later.filter((w) => w.remindAt! <= now);
    if (due.length) this.deps.due(due);
    const next = Math.min(...later.filter((w) => w.remindAt! > now).map((w) => w.remindAt!));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => this.arm(), Math.min(next - now, LONGEST_WAIT_MS));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** What the reminder says: the conversation, and what waits there (failing checks, a conflict, news). */
export function reminderNotice(state: Pick<DomainState, 'prs' | 'conflicts' | 'unread'>, ws: Pick<Workspace, 'id' | 'name'>): NoticeEvent {
  const channel = `ws:${ws.id}`;
  const pr = state.prs[ws.id];
  const unread = state.unread[channel] ?? 0;
  const waiting = [
    state.conflicts[ws.id]?.length ? 'A merge conflict to resolve' : '',
    pr?.state === 'OPEN' && pr.checks === 'failing' ? 'Checks failed on its pull request' : '',
    unread ? `${unread} new message${unread === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return { kind: 'needsYou', title: `Reminder: ${ws.name}`, body: waiting.join(' · ') || 'You asked to be reminded about it', channel, key: `remind:${ws.id}:${Date.now()}` };
}
