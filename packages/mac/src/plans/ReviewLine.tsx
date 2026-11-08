import { type Plan, type ReviewFinding, reviewState } from '@beluga/core/plans/model.js';
import { verifyProgress } from '@beluga/core/plans/verify-progress.js';
import { formatDuration } from '@beluga/shared/text.js';
import { useApp } from '../lib/beluga.js';
import { LiveDot } from './marks.js';
import { useClock } from './use-plans.js';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import { TonePill } from './marks.js';
import type { Tone } from './plans-model.js';
import { usePlanActions } from './use-plans.js';

/**
 * While a fresh agent verifies the plan: never a still line that could be taken for stuck (BLG-772).
 * How long it's been at it, its four checks lit up as it reaches each, its latest words as they
 * come (each new line fading in), a soft sweep along the bottom, and Watch It Work to see its
 * conversation in full.
 */
function Verifying({ plan }: { plan: Plan }) {
  const review = plan.review!;
  const channel = review.chat ? `ws:${review.chat}` : undefined;
  // Its run for this round (not one from an earlier round in the same conversation).
  const run = useApp((s) => (channel ? s.log.findLast((l) => l.type === 'agent' && l.channel === channel && l.ts >= review.at - 2000) : undefined));
  const progress = verifyProgress(run?.type === 'agent' ? run : undefined);
  const now = useClock(true);
  const { openWorktree } = usePlanActions();
  const took = Math.max(0, (now || Date.now()) - (progress.startedAt ?? review.at));
  return (
    <div className={cx(p.changes, p.review, p.verifying)} role="status" aria-label="Verifying the plan">
      <div className={p.reviewHead}>
        <LiveDot />
        <strong>Verifying the plan</strong>
        <span className={p.verifyTime}>{formatDuration(took)}</span>
        <span className={p.verifyWhy}>A fresh agent checks it for contradictions, duplicates and stale decisions{review.thenApprove ? ', then approves it if nothing needs fixing' : ''}.</span>
        <span className={p.grow} />
        {review.chat ? (
          <Button size="small" variant="quiet" icon="eye" onClick={() => openWorktree(review.chat!)}>
            Watch It Work
          </Button>
        ) : null}
      </div>
      <ol className={p.verifyChecks} aria-label="Checks">
        {progress.checks.map((c) => (
          <li key={c.key} className={p.verifyCheck} data-state={c.state}>
            {c.state === 'done' ? <Icon name="check" size={11} /> : c.state === 'now' ? <LiveDot /> : <span className={p.verifyTodo} aria-hidden="true" />}
            {c.label}
          </li>
        ))}
      </ol>
      <div key={progress.now} className={cx(p.verifyNow, progress.said && p.verifySaid, 'selectable')}>
        {progress.now}
      </div>
      <span className={p.verifyBar} aria-hidden="true" />
    </div>
  );
}
import p from './plans.module.css';

/** What each kind of finding is called, and its tone. */
export const FINDING_WORDS: Readonly<Record<ReviewFinding['kind'], { readonly label: string; readonly tone: Tone }>> = {
  contradiction: { label: 'Contradiction', tone: 'warn' },
  duplicate: { label: 'Duplicate', tone: 'info' },
  stale: { label: 'Stale', tone: 'accent' },
  order: { label: 'Order', tone: 'claude' },
  other: { label: 'Other', tone: 'neutral' },
};

/**
 * Verifying a first draft, when you asked (BLG-772): while a fresh agent reads it, one line; once
 * it found things, the list, with Fix (sent to your agent) and Approve Anyway. A clean read says
 * nothing here: the plan is approved (Verify, Then Approve), or Approve Plan is simply there.
 */
export function ReviewLine({ plan, onApprove }: { plan: Plan; onApprove: () => void }) {
  const { api, act } = usePlanActions();
  const state = reviewState(plan);
  const review = plan.review;
  if (state === 'reviewing' && review) return <Verifying plan={plan} />;
  if (state !== 'findings' || !review) return null;
  const n = review.findings.length;
  return (
    <div className={cx(p.changes, p.review)} role="status">
      <div className={p.reviewHead}>
        <Icon name="eye" size={13} />
        <strong>{review.fixAsked ? 'Your agent is fixing what verifying found' : `Verifying found ${n === 1 ? 'one thing' : `${n} things`} to fix`}</strong>
        <span className={p.grow} />
        {review.fixAsked ? (
          <Button size="small" variant="quiet" onClick={() => void act(() => api.verify(plan.id, { thenApprove: true }))}>
            Verify, Then Approve
          </Button>
        ) : (
          <>
            <Button size="small" variant="quiet" onClick={onApprove}>
              Approve Anyway
            </Button>
            <Button size="small" variant="primary" icon="wand" onClick={() => void act(() => api.fixReview(plan.id), 'Sent to your agent')}>
              Fix
            </Button>
          </>
        )}
      </div>
      <ol className={p.findings}>
        {review.findings.map((f, i) => (
          <li key={i} className={p.finding}>
            <TonePill tone={FINDING_WORDS[f.kind].tone}>{FINDING_WORDS[f.kind].label}</TonePill>
            <span className="selectable">{f.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
