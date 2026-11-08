import type { Store } from '../store.js';
import { type Plan, type ReviewFinding, FINDING_KINDS, reviewState } from './model.js';
import type { Plans } from './plans.js';
import { liveFrom } from './progress.js';
import { reviewFixPrompt, reviewNudgePrompt, reviewPrompt } from './prompt.js';

/**
 * Verifying a first draft, when you ask (BLG-772): Approve Plan's ▾ › Verify, Then Approve (or
 * ••• › Verify the Plan). The agent that wrote a plan over many messages is the worst at seeing its
 * own drift, so a fresh agent reads it, read-only (plan_get, and plan_review to record what it
 * found), in a conversation of its own folded into the plan, like a milestone's checker. It looks
 * for contradictions, duplicates, stale decisions and wrong order. Reading well, the plan is
 * approved (when you asked for that); otherwise its findings show on the plan's page: Fix sends
 * them to the plan's agent, or Approve Anyway. Never automatic: it takes a while, and most drafts
 * don't need it (the cheap checks in coherence.ts run on every change).
 */

export interface DraftReviewDeps {
  readonly store: Store;
  readonly plans: Plans;
  readonly askClaude: (prompt: string, channel: string, echo: boolean) => string | void;
  /** A conversation of its own to review a draft in (its workspace id). None: drafts can't be verified. */
  readonly reviewChat?: (plan: Plan) => Promise<string | undefined>;
  /** The plan's agent for a conversation it had already (picked since in Verify, Then Approve ▸). */
  readonly chatAgent?: (chat: string, plan: Plan) => void;
  /** Approve the plan (Verify, Then Approve, once it reads well). */
  readonly approve?: (planId: string) => void;
  /** A run of Claude's is under way in a conversation (the agent runner's run state). */
  readonly alive?: (channel: string) => boolean;
  /** Beluga no longer needs a request of its own (a review of an older draft). */
  readonly cancel?: (requestId: string) => void;
  readonly now?: () => number;
  readonly delayMs?: number;
}

/** A review asked before a restart, nothing running in its conversation this long after: it ended without findings. */
const REVIEW_QUIET_MS = 60_000;
const MAX_FINDINGS = 20;
const RUNNING = new Set(['queued', 'awaiting_approval', 'started', 'answered']);
const WS = 'ws:';

export class DraftReviewer {
  /** The review's request, by plan (to follow it, and stop it when asked again). */
  private readonly runs = new Map<string, string>();
  /** Reviews asked once more for their findings (`plan:rev`). */
  private readonly nudged = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly off: () => void;

  constructor(private readonly deps: DraftReviewDeps) {
    this.off = deps.store.onAction((a) => {
      if (a.type === 'plan_put' || a.type === 'agent_event') this.soon(deps.delayMs ?? 500);
    });
  }

  stop(): void {
    this.stopped = true;
    this.off();
    clearTimeout(this.timer);
  }

  /** Whether drafts can be verified here (a conversation can be made for it). */
  get available(): boolean {
    return Boolean(this.deps.reviewChat);
  }

  private now = (): number => this.deps.now?.() ?? Date.now();

  private soon(wait: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.look();
    }, wait);
    this.timer.unref?.();
  }

  private busy(channel: string): boolean {
    return liveFrom(this.deps.store.getState()).busy(channel) || Boolean(this.deps.alive?.(channel));
  }

  /** The reviews under way, followed (one that ends without findings is asked once more). */
  look(): void {
    for (const plan of this.deps.plans.list()) {
      if (reviewState(plan) !== 'reviewing') continue;
      try {
        this.watch(plan);
      } catch (err) {
        this.deps.plans.note(plan.id, 'problem', `couldn’t follow the plan’s verification: ${err instanceof Error ? err.message : String(err)}`, { kind: 'beluga' });
      }
    }
  }

  /** Verify the draft as it is now (`thenApprove`: approve it once it reads well). */
  async verify(planId: string, thenApprove: boolean): Promise<Plan> {
    const plan = this.deps.plans.need(planId);
    const state = reviewState(plan);
    if (state === 'off') throw new Error('Only a draft that isn’t approved yet is verified');
    if (!this.deps.reviewChat) throw new Error('Verifying a plan isn’t available here');
    if (state === 'reviewing') return this.deps.plans.setReview(planId, { ...plan.review!, ...(thenApprove ? { thenApprove } : {}) });
    const rev = plan.draftRev;
    const had = plan.review;
    const old = this.runs.get(planId);
    if (old) {
      this.deps.cancel?.(old);
      this.runs.delete(planId);
    }
    // Under way at once (the page says so), while its conversation is made.
    this.deps.plans.setReview(planId, { rev, at: this.now(), state: 'reviewing', findings: [], ...(had?.chat ? { chat: had.chat } : {}), ...(thenApprove ? { thenApprove } : {}) });
    try {
      const chat = await this.chatFor(plan);
      const now = this.deps.plans.need(planId);
      if (now.review?.rev !== rev || now.review.state !== 'reviewing') return now;
      if (!chat) throw new Error('its conversation couldn’t be made');
      this.deps.plans.setReview(planId, { ...now.review, chat });
      const id = this.deps.askClaude(reviewPrompt(now, Boolean(had?.chat === chat && had.state !== 'reviewing')), `${WS}${chat}`, false);
      if (id) this.runs.set(planId, id);
    } catch (err) {
      const now = this.deps.plans.get(planId);
      if (now) {
        this.deps.plans.setReview(planId, { rev, at: this.now(), state: 'failed', findings: [], ...(now.review?.chat ? { chat: now.review.chat } : {}) });
        this.deps.plans.note(planId, 'problem', `couldn’t verify the plan: ${err instanceof Error ? err.message : String(err)}`, { kind: 'beluga' });
      }
    }
    return this.deps.plans.need(planId);
  }

  /** The conversation it had (still there), or a new one. */
  private async chatFor(plan: Plan): Promise<string | undefined> {
    const was = plan.review?.chat;
    const ws = was ? this.deps.store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === was) : undefined;
    if (ws && !ws.archived) {
      this.deps.chatAgent?.(ws.id, plan);
      return ws.id;
    }
    return this.deps.reviewChat?.(plan);
  }

  /** A review whose turn ended without plan_review: asked once more, then Approve Plan is offered as it is. */
  private watch(plan: Plan): void {
    const review = plan.review!;
    if (!review.chat) return;
    const channel = `${WS}${review.chat}`;
    const id = this.runs.get(plan.id);
    const state = this.deps.store.getState();
    let ended: boolean;
    if (id) {
      const item = state.log.find((l) => l.type === 'agent' && l.requestId === id);
      ended = item?.type === 'agent' && !RUNNING.has(item.status);
    } else ended = !this.busy(channel) && this.now() - review.at > REVIEW_QUIET_MS;
    if (!ended) {
      if (!id) this.soon(REVIEW_QUIET_MS);
      return;
    }
    const key = `${plan.id}:${review.rev}`;
    if (!this.nudged.has(key)) {
      this.nudged.add(key);
      const again = this.deps.askClaude(reviewNudgePrompt, channel, false);
      if (again) this.runs.set(plan.id, again);
      else this.runs.delete(plan.id);
      return;
    }
    this.runs.delete(plan.id);
    const { thenApprove: _t, ...rest } = review;
    this.deps.plans.setReview(plan.id, { ...rest, state: 'failed', at: this.now() });
    this.deps.plans.note(plan.id, 'note', 'verifying the plan ended without findings: approve it as it is, or verify it again', { kind: 'beluga' });
  }

  /** The reviewer's plan_review → its answer, in words. Read well and asked to: the plan is approved. */
  record(planId: string, findings: readonly ReviewFinding[]): string {
    const plan = this.deps.plans.need(planId);
    const review = plan.review;
    if (!review) throw new Error('There’s no review of this draft under way');
    if (review.rev !== plan.draftRev || reviewState(plan) === 'off') return 'The draft changed while you read it: your findings no longer apply. End your turn.';
    const clean = findings
      .map((f) => ({ kind: FINDING_KINDS.includes(f.kind) ? f.kind : ('other' as const), text: f.text.replace(/\s+/g, ' ').trim().slice(0, 1000), ...(f.ids?.length ? { ids: [...new Set(f.ids)].slice(0, 12) } : {}) }))
      .filter((f) => f.text)
      .slice(0, MAX_FINDINGS);
    this.runs.delete(planId);
    const { thenApprove, ...rest } = review;
    this.deps.plans.setReview(planId, { ...rest, state: 'done', at: this.now(), findings: clean });
    const n = clean.length;
    this.deps.plans.note(planId, 'note', n ? `verified the plan and found ${n === 1 ? 'one thing' : `${n} things`} to fix` : 'verified the plan: nothing to fix', { kind: 'beluga' });
    const say = (text: string): void => this.deps.store.dispatch({ type: 'system', channel: plan.home, text, level: 'info' });
    if (n) {
      say(`Verified the plan: ${n === 1 ? 'one thing' : `${n} things`} to look at before it’s approved. Fix, or Approve Anyway, on the plan.`);
      return 'Recorded: the user sees your findings before approving. End your turn.';
    }
    if (thenApprove && this.deps.approve) {
      try {
        this.deps.approve(planId);
        say('Verified the plan: nothing to fix, so it’s approved and starting.');
      } catch (err) {
        say(`Verified the plan: nothing to fix, but it couldn’t be approved: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else say('Verified the plan: nothing to fix.');
    return 'Recorded. End your turn.';
  }

  /** Fix: the findings go to the plan's agent. */
  fix(planId: string): Plan {
    const plan = this.deps.plans.need(planId);
    const review = plan.review;
    if (reviewState(plan) !== 'findings' || !review) throw new Error('There’s nothing from the review to fix');
    this.deps.askClaude(reviewFixPrompt(review.findings), plan.home, true);
    return this.deps.plans.setReview(planId, { ...review, fixAsked: true });
  }
}
