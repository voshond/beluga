import type { DomainState } from '../store.js';
import { planOf } from '../plans/owner.js';
import { sentinelOfChannel } from '../sentinel/model.js';

/**
 * Each chat's category for one person: Active (the UI says Inbox), Working, Snoozed (the UI says
 * Later: Remind Me Later) or Settled. Pure rules, no clock and no files, so the daemon, the Mac and
 * the phone's views read the same answer. The state itself lives in ~/.beluga/triage.json on that
 * person's computer (service.ts). A snooze is Remind Me Later, and works with the categories off too.
 */

export type ChatCategory = 'active' | 'working' | 'snoozed' | 'settled';
export type SettleWhy = 'you' | 'pr_merged' | 'merged_here' | 'idle';

/** One chat's record, by channel: `ws:<id>` for own and shared chats, `plan:<id>` for a plan's row. */
export interface ChatTriage {
  readonly settled?: { readonly at: number; readonly why: SettleWhy; readonly pr?: number };
  /** `seen`: the approval and question ids open when you snoozed; those don't end the snooze. */
  readonly snoozed?: { readonly at: number; readonly until: number; readonly seen: readonly string[] };
  /** A snooze ended on its own at this time; the chat shows Back until you open it. */
  readonly backAt?: number;
  /** You turned auto-settle off for this chat. */
  readonly autoSettle?: false;
  /** The last PR that settled it: that PR doesn't settle it again. */
  readonly settledPr?: number;
  /** You un-settled it: no idle settle until new activity. */
  readonly holdIdle?: true;
  /** The last activity in the chat. */
  readonly lastAt?: number;
  /** It merged into main here while it couldn't settle yet (a turn ran, a hand was up). */
  readonly mergedHere?: true;
  /** A friend's chat: it may be away while they're offline, so a load doesn't take it for deleted. */
  readonly shared?: true;
}

export interface TriageFacts {
  readonly handRaised: boolean;
  readonly working: boolean;
}

/** What could raise a hand in a chat, read from the state. */
export interface HandSource {
  /** Ids of its open approvals and questions. */
  readonly openIds: readonly string[];
  readonly planStuck: boolean;
  /** When its latest failed run ended. */
  readonly failedAt?: number;
}

export type TriageEvent =
  | { readonly kind: 'settle'; readonly at: number; readonly why: SettleWhy; readonly pr?: number }
  | { readonly kind: 'unsettle' }
  | { readonly kind: 'snooze'; readonly at: number; readonly until: number; readonly seen: readonly string[] }
  | { readonly kind: 'wake'; readonly at: number }
  | { readonly kind: 'own_message'; readonly at: number }
  | { readonly kind: 'answer'; readonly at: number }
  | { readonly kind: 'mention'; readonly at: number }
  | { readonly kind: 'person_message'; readonly at: number }
  | { readonly kind: 'hand_raised'; readonly at: number }
  | { readonly kind: 'turn_start'; readonly at: number }
  | { readonly kind: 'turn_end'; readonly at: number }
  | { readonly kind: 'agent_text'; readonly at: number }
  | { readonly kind: 'auto_settle'; readonly on: boolean }
  | { readonly kind: 'merged_here' }
  | { readonly kind: 'system' };

export type TriageSource = Pick<DomainState, 'projects' | 'shared' | 'plans' | 'board' | 'sentinel'>;

export const SETTLE_WORKING_MESSAGE = 'This chat is working. Settle it when its turn ends, or remind yourself later now.';

const NO_RECORD: ChatTriage = {};

/**
 * Which record speaks for a conversation: its own, or its plan's row. None for what has no category:
 * the room, Your Mac, friends' chats, a sentinel's chats, archived worktrees, a project's main folder
 * and a worktree made outside Beluga that nobody talked in (a Claude Code sub-agent's left-over).
 */
export function triageKey(state: TriageSource, channel: string): string | undefined {
  if (channel.startsWith('plan:')) return state.plans.plans.some((p) => `plan:${p.id}` === channel) ? channel : undefined;
  if (!channel.startsWith('ws:') || sentinelOfChannel(state.sentinel, channel)) return undefined;
  const id = channel.slice(3);
  const plan = planOf(state, id);
  if (plan) return `plan:${plan.id}`;
  const own = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
  if (own) return own.archived || own.kind === 'main' || own.external ? undefined : channel;
  return state.shared.some((w) => w.id === id) ? channel : undefined;
}

/** The category a chat shows: a raised hand wins over all, then a snooze, a settle, a running turn. */
export function categoryOf(record: ChatTriage | undefined, facts: TriageFacts): ChatCategory {
  if (facts.handRaised) return 'active';
  if (record?.snoozed) return 'snoozed';
  if (record?.settled) return 'settled';
  if (facts.working) return 'working';
  return 'active';
}

/**
 * Whether the chat needs you. What was open when you snoozed stays quiet, and a failed run counts
 * only against a snooze: without one, a failure is just the turn's end. Merge conflicts and failing
 * checks show on the row but never raise a hand.
 */
export function handRaisedOf(record: ChatTriage | undefined, source: HandSource): boolean {
  if (source.planStuck) return true;
  const seen = record?.snoozed?.seen ?? [];
  if (source.openIds.some((id) => !seen.includes(id))) return true;
  return record?.snoozed !== undefined && source.failedAt !== undefined && source.failedAt > record.snoozed.at;
}

/** Why this chat can't settle now: a running turn stops it, except when you settle a snoozed chat. */
export function settleRefusal(record: ChatTriage | undefined, facts: Pick<TriageFacts, 'working'>, why: SettleWhy): string | undefined {
  if (!facts.working) return undefined;
  return why === 'you' && record?.snoozed ? undefined : SETTLE_WORKING_MESSAGE;
}

/** The record after an event (tests/chat-triage.test.ts has one test for each row of the transition table). Check settleRefusal first. */
export function applyTriage(record: ChatTriage | undefined, event: TriageEvent): ChatTriage {
  const was = record ?? NO_RECORD;
  switch (event.kind) {
    case 'settle':
      return settle(was, event);
    case 'unsettle':
      return was.settled ? { ...without(was, 'settled'), holdIdle: true } : was;
    case 'snooze':
      return { ...without(was, 'settled', 'backAt'), snoozed: { at: event.at, until: event.until, seen: event.seen } };
    case 'wake':
      return was.snoozed ? { ...touched(without(was, 'snoozed'), event.at), backAt: event.at } : was;
    case 'own_message':
    case 'answer':
      return touched(without(was, 'snoozed', 'settled', 'backAt'), event.at);
    case 'mention':
    case 'hand_raised':
      return touched(raised(was, event.at), event.at);
    case 'person_message':
      return touched(without(was, 'settled'), event.at);
    case 'turn_start':
      return touched(without(was, 'settled'), event.at);
    case 'turn_end':
    case 'agent_text':
      return touched(was, event.at);
    case 'auto_settle':
      return event.on ? without(was, 'autoSettle') : { ...was, autoSettle: false };
    case 'merged_here':
      return { ...was, mergedHere: true };
    case 'system':
      return was;
  }
}

function settle(was: ChatTriage, event: Extract<TriageEvent, { kind: 'settle' }>): ChatTriage {
  const settled = { at: event.at, why: event.why, ...(event.pr !== undefined ? { pr: event.pr } : {}) };
  return { ...without(was, 'snoozed', 'backAt', 'holdIdle', 'mergedHere'), settled, ...(event.pr !== undefined ? { settledPr: event.pr } : {}) };
}

/** Someone or something needs you: a settle or a snooze ends, and a snooze that ended shows Back. */
function raised(was: ChatTriage, at: number): ChatTriage {
  const rest = without(was, 'settled', 'snoozed');
  return was.snoozed ? { ...rest, backAt: at } : rest;
}

const touched = (record: ChatTriage, at: number): ChatTriage => ({ ...without(record, 'holdIdle'), lastAt: at });

function without(record: ChatTriage, ...keys: readonly (keyof ChatTriage)[]): ChatTriage {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k as keyof ChatTriage))) as ChatTriage;
}
