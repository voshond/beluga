import type { DomainState } from '@beluga/core/store.js';
import { planMilestonesOnly, planOfChannel } from '@beluga/core/notify.js';
import { type NoticeTarget, noticeTarget } from '@beluga/ui/notice-models.js';
import type { Actions } from './actions.js';

/** Where a notification goes in this window: the shared places, a conversation with friends, or a plan (at one of its tasks). */
export type MacNoticeTarget = NoticeTarget | { readonly kind: 'conversation'; readonly id: string } | { readonly kind: 'plan'; readonly id: string; readonly task?: string } | { readonly kind: 'task'; readonly id: string };

/**
 * The place a notice is about (a conversation with a friend or a group is this window's own). A
 * plan's task or home opens the plan there, while plans speak for their tasks (Settings › Notifications).
 */
export function macNoticeTarget(state: Pick<DomainState, 'projects' | 'shared' | 'network' | 'plans' | 'board' | 'prefs'>, channel: string | undefined, plan?: { readonly id: string; readonly task?: string }): MacNoticeTarget | undefined {
  if (plan && state.plans.plans.some((p) => p.id === plan.id)) return { kind: 'plan', ...plan };
  const place = planMilestonesOnly(state.prefs.notify) ? planOfChannel(state, channel) : undefined;
  if (place && place.plan.status !== 'draft' && (place.issue || place.plan.status === 'active')) return { kind: 'plan', id: place.plan.id, ...(place.task ? { task: place.task } : {}) };
  // A task's comment that mentions you (BLG-419): its page.
  if (channel?.startsWith('task:')) {
    const id = channel.slice(5);
    return state.board.issues.some((i) => i.id === id) ? { kind: 'task', id } : undefined;
  }
  if (channel?.startsWith('dm:') || channel?.startsWith('group:')) {
    const id = channel.slice(channel.indexOf(':') + 1);
    const known = channel.startsWith('dm:') ? state.network.friends.some((f) => f.peerId === id) : state.network.groups.some((g) => g.id === id);
    return known ? { kind: 'conversation', id: channel } : undefined;
  }
  return noticeTarget(state, channel);
}

/** Go where a notification is about: the room, one of your workspaces, one shared with you, or a conversation with friends. */
export function openNoticeTarget(actions: Actions, target: MacNoticeTarget, go?: (id: string) => void): void {
  if (target.kind === 'conversation') go?.(target.id);
  else if (target.kind === 'task') actions.run({ type: 'view', view: { kind: 'task', id: target.id } });
  else if (target.kind === 'plan') actions.run({ type: 'view', view: { kind: 'plan', id: target.id, ...(target.task ? { task: target.task } : {}) } });
  else if (target.kind === 'room') actions.run({ type: 'view', view: { kind: 'room' } });
  else if (target.kind === 'assistant') actions.run({ type: 'view', view: { kind: 'assistant', ...(target.chat ? { chat: target.chat } : {}) } });
  else if (target.kind === 'sentinel_chat') actions.run({ type: 'view', view: { kind: 'sentinel_chat', chat: target.chat } });
  else if (target.kind === 'initiative') actions.run({ type: 'view', view: { kind: 'initiative_page', slug: target.slug, chat: target.chat } });
  else if (target.kind === 'shared') actions.run({ type: 'open_shared', owner: target.owner, id: target.id, tab: 'chat' });
  else actions.run({ type: 'open_ws', id: target.id });
}

/** A desktop notification was clicked (the app shell or the browser says so with this event). */
export const NOTIFICATION_TAP = 'beluga:notification-tap';

/** A friend's message to show as a banner in the window (you're in Beluga, looking elsewhere). */
export const MESSAGE_BANNER = 'beluga:message-banner';
export interface MessageBannerDetail {
  readonly title: string;
  readonly body: string;
  readonly channel?: string;
}
