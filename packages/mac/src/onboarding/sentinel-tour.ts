import type { Access, ClaudeWhere, StepKind, TriggerKind } from '../../../../src/core/sentinel/model.js';
import { computerWord } from '../lib/os-words.js';

/**
 * The tour's Sentinel step (BLG-362): a few real sentinels, each said in a sentence (when, what,
 * and how you hear of it) and built from the same parts the Sentinel page has. One trigger, a
 * few steps, the access they need, and the report the run leaves. Pure, so a test can hold every
 * one to what Sentinel really allows (tests/mac-onboarding.test.ts).
 */

export interface TourStep {
  readonly kind: StepKind;
  /** What this step does here ("Write a brief of what changed"). */
  readonly detail: string;
  /** Where Claude works, for an Ask Claude step (a worktree needs Work access). */
  readonly where?: ClaudeWhere;
}

export interface TourSentinel {
  readonly id: string;
  readonly name: string;
  /** The sentence it's described in: when, what Claude does, and how you hear of it. */
  readonly said: readonly [when: string, what: string, then: string];
  readonly trigger: TriggerKind;
  /** The trigger in the Sentinel page's own words. */
  readonly when: string;
  readonly steps: readonly TourStep[];
  readonly access: Access;
  /** What the run left, in a line. */
  readonly report: { readonly title: string; readonly line: string };
}

export const TOUR_SENTINELS: readonly TourSentinel[] = [
  {
    id: 'brief',
    name: 'Morning brief',
    said: ['Every morning at 7,', 'have my agent sum up what changed', 'and send it to my phone.'],
    trigger: 'schedule',
    when: 'Every day at 7:00',
    steps: [
      { kind: 'claude', detail: 'Write a brief of what changed', where: 'project' },
      { kind: 'notify', detail: `On the ${computerWord()} and the phone` },
    ],
    access: 'look',
    report: { title: 'Morning brief', line: '3 pull requests merged, 1 test failing, 2 new issues' },
  },
  {
    id: 'ci',
    name: 'Fix the build',
    said: ['When the tests fail on GitHub,', 'have my agent fix them in a worktree', 'and merge once the checks pass.'],
    trigger: 'github',
    when: 'When a workflow fails',
    steps: [
      { kind: 'claude', detail: 'Investigate and fix it', where: 'worktree' },
      { kind: 'pr', detail: 'With the project’s PR instructions' },
      { kind: 'merge', detail: 'Checks green, and you’ve approved' },
    ],
    access: 'ship',
    report: { title: '#52 merged', line: 'checkout tests: a timeout raised to 10 s' },
  },
  {
    id: 'errors',
    name: 'New errors',
    said: ['When Sentry sees a new error,', 'turn it into a task', 'and tell the team.'],
    trigger: 'sentry',
    when: 'When Sentry sees a new issue',
    steps: [
      { kind: 'claude', detail: 'Turn this into tasks', where: 'project' },
      { kind: 'message', detail: 'To the team chat, tagging @mia' },
    ],
    access: 'look',
    report: { title: 'Task opened', line: 'A TypeError in checkout, 38 users so far' },
  },
  {
    id: 'site',
    name: 'Site watch',
    said: ['When my site stops answering,', 'check the server', 'and ping Slack and my phone.'],
    trigger: 'uptime',
    when: 'When example.com stops answering',
    steps: [
      { kind: 'script', detail: './scripts/health.sh' },
      { kind: 'http', detail: 'Slack webhook' },
      { kind: 'notify', detail: 'On the phone' },
    ],
    access: 'look',
    report: { title: 'Back up', line: 'Down 4 min, the database restarted at 3:16' },
  },
  {
    id: 'numbers',
    name: 'Daily numbers',
    said: ['Every hour,', 'count sign-ups and revenue', 'and keep them on my board.'],
    trigger: 'schedule',
    when: 'Every hour',
    steps: [{ kind: 'measure', detail: 'Sign-ups and revenue from Postgres' }],
    access: 'look',
    report: { title: 'Sign-ups 35', line: 'Up 21% on yesterday, on your board and desktop' },
  },
];

