import type { DomainState } from '../core/store.js';
import { initiativeChatOf } from '../core/initiatives/model.js';
import { assistantChatOf } from '../shared/assistant.js';
import { sentinelChatOf } from '../core/sentinel/model.js';
import type { Notice } from '../core/work-store.js';
import { findWorkspace } from './workspace-models.js';

// The inbox as the app shows it: filters, Today / Earlier, how each notice looks, where it goes.

export type NoticeFilter = 'all' | 'unread' | 'needsYou' | 'mentions';

export const NOTICE_FILTERS: ReadonlyArray<{ readonly value: NoticeFilter; readonly label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'needsYou', label: 'Needs you' },
  { value: 'mentions', label: 'Mentions' },
];

export function filterNotices(inbox: readonly Notice[], filter: NoticeFilter): readonly Notice[] {
  switch (filter) {
    case 'all':
      return inbox;
    case 'unread':
      return inbox.filter((n) => !n.read);
    case 'needsYou':
      return inbox.filter((n) => n.kind === 'needsYou');
    case 'mentions':
      return inbox.filter((n) => n.kind === 'mentions');
  }
}

export interface NoticeGroup {
  readonly label: 'Today' | 'Earlier';
  readonly notices: readonly Notice[];
}

/** Newest first, split at local midnight. Empty groups are left out. */
export function groupNotices(inbox: readonly Notice[], now = Date.now()): readonly NoticeGroup[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const sorted = [...inbox].sort((a, b) => b.ts - a.ts);
  const groups: NoticeGroup[] = [
    { label: 'Today', notices: sorted.filter((n) => n.ts >= midnight.getTime()) },
    { label: 'Earlier', notices: sorted.filter((n) => n.ts < midnight.getTime()) },
  ];
  return groups.filter((g) => g.notices.length);
}

/** One row of the bell: a notice, or a plan's task news folded together under the plan. */
export type NoticeEntry = { readonly kind: 'one'; readonly notice: Notice } | { readonly kind: 'plan'; readonly plan: string; readonly notices: readonly Notice[] };

/** News from a plan's tasks (finished, stopped, pull requests): the plan's own notices and its questions stay rows. */
const taskNews = (n: Notice): boolean => Boolean(n.plan) && n.tag !== 'milestone' && n.tag !== 'conflict' && n.kind !== 'needsYou';

/** A plan's task news folds into one entry where its newest is (two or more; one alone stays a row). Order kept. */
export function foldPlanNotices(list: readonly Notice[]): readonly NoticeEntry[] {
  const byPlan = new Map<string, Notice[]>();
  for (const n of list) if (taskNews(n)) (byPlan.get(n.plan!) ?? byPlan.set(n.plan!, []).get(n.plan!)!).push(n);
  const out: NoticeEntry[] = [];
  for (const n of list) {
    const group = taskNews(n) ? byPlan.get(n.plan!) : undefined;
    if (!group || group.length < 2) out.push({ kind: 'one', notice: n });
    else if (group[0] === n) out.push({ kind: 'plan', plan: n.plan!, notices: group });
  }
  return out;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "now", "4m", "2h", then "Yesterday", a weekday, or a date. */
export function noticeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const d = new Date(ts);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `${Math.floor(s / 3600)}h`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (s < 6 * 86_400) return DAYS[d.getDay()]!;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** What a notice is about, for its icon (each screen draws its own). */
export type NoticeLook = 'approval' | 'question' | 'plan' | 'done' | 'problem' | 'joined' | 'left' | 'invited' | 'people' | 'mention' | 'message' | 'pr' | 'task' | 'test';

/** How loud a notice is: needs you (warn), went wrong (error), Claude (claude), the rest (muted). */
export type NoticeTone = 'warn' | 'error' | 'claude' | 'info' | 'muted';

export function noticeLook(n: Pick<Notice, 'kind' | 'tag'>): { readonly look: NoticeLook; readonly tone: NoticeTone } {
  switch (n.tag) {
    case 'approval':
    case 'question':
    case 'plan':
      return { look: n.tag, tone: 'warn' };
    case 'conflict':
      return { look: 'problem', tone: 'error' };
    case 'joined':
    case 'left':
    case 'invited':
      return { look: n.tag, tone: 'muted' };
    case 'mention':
    case 'message':
      return { look: n.tag, tone: 'info' };
    case 'task':
      return { look: 'task', tone: 'muted' };
    case 'test':
      return { look: 'test', tone: 'claude' };
  }
  switch (n.kind) {
    case 'done':
      return { look: 'done', tone: 'claude' };
    case 'needsYou':
      return { look: 'question', tone: 'warn' };
    case 'problems':
      return { look: 'problem', tone: 'error' };
    case 'people':
      return { look: 'people', tone: 'muted' };
    case 'mentions':
      return { look: 'mention', tone: 'info' };
    case 'pr':
      return { look: 'pr', tone: 'muted' };
    case 'background':
      return { look: 'task', tone: 'muted' };
  }
}

/** Where opening a notice goes: the room, Your Mac, the Sentinel chat, one of your workspaces, or one shared with you. */
export type NoticeTarget = { readonly kind: 'room' } | { readonly kind: 'assistant'; readonly chat?: string } | { readonly kind: 'sentinel_chat'; readonly chat: string } | { readonly kind: 'workspace'; readonly id: string } | { readonly kind: 'shared'; readonly owner: string; readonly id: string } | { readonly kind: 'initiative'; readonly slug: string; readonly chat: string };

export function noticeTarget(state: Pick<DomainState, 'projects' | 'shared'>, channel: string | undefined): NoticeTarget | undefined {
  if (channel === 'room') return { kind: 'room' };
  const chat = assistantChatOf(channel);
  if (chat) return { kind: 'assistant', chat };
  const sentinelChat = sentinelChatOf(channel);
  if (sentinelChat) return { kind: 'sentinel_chat', chat: sentinelChat };
  const initiative = initiativeChatOf(channel);
  if (initiative) return { kind: 'initiative', ...initiative };
  if (!channel?.startsWith('ws:')) return undefined;
  const id = channel.slice(3);
  const shared = state.shared.find((w) => w.id === id);
  if (shared) return { kind: 'shared', owner: shared.owner, id };
  const ws = findWorkspace(state.projects, id);
  // A project's main checkout is no conversation (BLG-70): the chat its old one became, if any.
  if (ws?.kind === 'main') return ws.movedTo && findWorkspace(state.projects, ws.movedTo) ? { kind: 'workspace', id: ws.movedTo } : undefined;
  return ws ? { kind: 'workspace', id } : undefined;
}

/**
 * The count on the Dock icon and the menu-bar icon: unread notices, plus what waits for you
 * (approvals, questions, people knocking) that has no unread notice of its own.
 */
export function badgeCount(state: Pick<DomainState, 'inbox' | 'approvals' | 'questions' | 'knocks'>): number {
  const unread = state.inbox.filter((n) => !n.read);
  const noted = new Set(unread.flatMap((n) => (n.ref === undefined ? [] : [n.ref])));
  const waiting = [...state.approvals.map((a) => a.id), ...state.questions.map((q) => q.qid)].filter((id) => !noted.has(id)).length;
  return unread.length + waiting + state.knocks.length;
}
