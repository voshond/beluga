import { planById } from '../plans/model.js';
import type { DomainState } from '../store.js';
import { channelsOf, handSourceOf, triageFacts } from './facts.js';
import { type SettleWhy, triageKey } from './model.js';

/**
 * Which chats settle by themselves now. It reads only state, so one rule covers a turn that ran
 * when the PR merged, a question answered later, a daemon restart and the first enable. It never
 * touches a task: the board follows the same PR on its own (Board.prChanged).
 */

export interface AutoSettled {
  readonly key: string;
  readonly why: SettleWhy;
  readonly pr?: number;
}

const DAY_MS = 86_400_000;

export function autoSettle(state: DomainState, now: number): readonly AutoSettled[] {
  if (!state.prefs.chatCategories) return [];
  const out = new Map<string, AutoSettled>();
  if (state.prefs.settleOnMerge) for (const settled of [...mergedHere(state), ...mergedPrs(state), ...mergedPlanPrs(state)]) out.set(settled.key, settled);
  if (state.prefs.settleIdleDays > 0) for (const key of idleChats(state, now)) if (!out.has(key)) out.set(key, { key, why: 'idle' });
  return [...out.values()];
}

const free = (state: DomainState, key: string): boolean => {
  const facts = triageFacts(state, key);
  return !facts.working && !facts.handRaised && state.triage[key]?.autoSettle !== false;
};

/** A merge waits for every open question and approval, also one a snooze hides: settling would end the snooze and spend the PR while it's unanswered. */
const freeToMerge = (state: DomainState, key: string): boolean => {
  const hands = handSourceOf(state, key);
  return free(state, key) && !hands.openIds.length && !hands.planStuck;
};

function mergedHere(state: DomainState): readonly AutoSettled[] {
  return Object.entries(state.triage)
    .filter(([key, record]) => record.mergedHere && freeToMerge(state, key))
    .map(([key]) => ({ key, why: 'merged_here' as const }));
}

/** A worktree's PR speaks only for a chat with its own row: a plan's later tasks can still wait after one of its tasks' PRs. */
function mergedPrs(state: DomainState): readonly AutoSettled[] {
  const out: AutoSettled[] = [];
  for (const ws of state.projects.flatMap((p) => p.workspaces)) {
    const pr = state.prs[ws.id];
    if (pr?.state !== 'MERGED' || ws.prDone === pr.number) continue;
    const key = `ws:${ws.id}`;
    if (triageKey(state, key) === key && mergeSettles(state, key, pr.number)) out.push({ key, why: 'pr_merged', pr: pr.number });
  }
  return out;
}

/** A plan's row settles on merge only from the plan's own PR (branch into main). */
function mergedPlanPrs(state: DomainState): readonly AutoSettled[] {
  const out: AutoSettled[] = [];
  for (const plan of state.plans.plans) {
    const key = `plan:${plan.id}`;
    if (plan.pr?.state === 'MERGED' && mergeSettles(state, key, plan.pr.number)) out.push({ key, why: 'pr_merged', pr: plan.pr.number });
  }
  return out;
}

const mergeSettles = (state: DomainState, key: string, pr: number): boolean => state.triage[key]?.settledPr !== pr && freeToMerge(state, key);

/** An open PR stops this: it can wait days for review, and its merge settles the chat later. A chat put off till later waits for its reminder. */
function idleChats(state: DomainState, now: number): readonly string[] {
  const limit = state.prefs.settleIdleDays * DAY_MS;
  return Object.entries(state.triage)
    .filter(([key, record]) => {
      if (record.lastAt === undefined || now - record.lastAt <= limit) return false;
      if (record.settled || record.snoozed || record.holdIdle) return false;
      return !hasUnread(state, key) && !hasOpenPr(state, key) && free(state, key);
    })
    .map(([key]) => key);
}

const hasUnread = (state: DomainState, key: string): boolean => channelsOf(state, key).some((c) => (state.unread[c] ?? 0) > 0);

function hasOpenPr(state: DomainState, key: string): boolean {
  if (key.startsWith('plan:') && planById(state.plans, key.slice(5))?.pr?.state === 'OPEN') return true;
  return channelsOf(state, key).some((c) => state.prs[c.slice(3)]?.state === 'OPEN');
}
