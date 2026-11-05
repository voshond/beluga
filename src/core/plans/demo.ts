import type { Actor } from '../board/model.js';
import type { BoardWork } from '../board/work.js';
import type { LogItem, Store } from '../store.js';
import type { PlansWork } from './work.js';

/**
 * The demo's plan: bob-api's payments launch, cut into three milestones. The first passed, the
 * second runs (one task in review, one in progress, one waiting on it), the third waits. It takes
 * in the demo board's tasks, so the board and the plan tell the same story. Step by step, so the
 * demo never starts worktrees by itself.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export async function seedDemoPlan(store: Store, work: PlansWork, board: BoardWork, travel: (msAgo: number) => void): Promise<void> {
  const api = store.getState().projects.find((p) => p.name === 'bob-api');
  if (!api) return;
  const { selfId, self } = store.getState();
  const me = self?.name ?? 'you';
  const asked = Date.now() - 4 * DAY;
  // How the plan began, saved but not loaded (as after a restart): the plan's chat loads it when the plan opens.
  const home = await work.homeFor(api.id, 'Card checkout for launch', (channel): LogItem[] => [
    { id: 'demo-plan-asked', type: 'chat', channel, from: selfId, name: me, text: 'Plan card checkout for the launch: behind auth, webhooks that never double-charge, and refunds from the admin.', ts: asked, byAgent: false },
    {
      id: 'demo-plan-drafted',
      type: 'agent',
      channel,
      subagents: [],
      requestId: 'demo-plan-drafted',
      owner: selfId,
      ownerName: me,
      requesterName: me,
      requester: selfId,
      status: 'done',
      text: 'I read the payment routes and the webhooks, and drafted the plan in three milestones: test-mode foundations first, then safe payments, then refunds and the launch checklist.',
      steps: [],
      ts: asked + 60_000,
      endTs: asked + 4 * 60_000,
    },
  ]);
  if (!home) return;
  const key = (title: string): string | undefined => board.board.list().find((i) => i.projectId === api.id && i.title === title)?.id;
  const fixtures = key('Stripe test-mode fixtures');
  const auth = key('Add auth to the payment routes');
  const retries = key('Idempotent webhook retries');
  const refunds = key('Refund endpoint');
  if (!fixtures || !auth || !retries || !refunds) return;
  const claude: Actor = board.myClaude();
  travel(3 * DAY + 22 * HOUR);
  const plan = work.plans.create({ projectId: api.id, home, goal: 'Take card payments for the launch', autonomy: 'step' }, board.me());
  work.plans.writeDraft(
    plan.id,
    {
      title: 'Card checkout for launch',
      goal: 'Take card payments safely by launch day: checkout behind auth, webhooks that never double-charge, refunds from the admin.',
      milestones: [
        {
          id: 'foundations',
          title: 'Test-mode foundations',
          goal: 'Every payment flow can be exercised locally with Stripe’s test mode.',
          criteria: ['`npm test` covers card, 3-D Secure and declined flows', 'Fixtures load without network access'],
          tasks: [{ id: 'fixtures', title: 'Stripe test-mode fixtures', issueId: fixtures, estimate: 2, touches: ['test/fixtures/stripe'], acceptance: ['Fixtures for card, 3-D Secure and declined cards', 'All payment tests use them'] }],
        },
        {
          id: 'safe-payments',
          title: 'Safe payments',
          goal: 'Only signed-in users pay, and a retried webhook is handled exactly once.',
          criteria: ['Unauthenticated calls to /api/payments/* get 401', 'Replaying one webhook three times marks the order paid once and sends one receipt', 'CI is green on both pull requests'],
          tasks: [
            { id: 'auth', title: 'Add auth to the payment routes', issueId: auth, estimate: 3, priority: 'urgent', touches: ['src/server.ts', 'src/auth'] },
            { id: 'retries', title: 'Idempotent webhook retries', issueId: retries, estimate: 5, priority: 'high', touches: ['src/webhooks', 'migrations'] },
            {
              id: 'receipts',
              title: 'Receipt emails sent once',
              goal: 'A paid order sends exactly one receipt, even when Stripe retries the webhook.',
              context: 'Receipts go out from `src/webhooks/paid.ts` today, before the order is saved.',
              acceptance: ['Receipts are sent after the order is marked paid', 'A replayed event sends no second receipt', 'A test covers it'],
              blockedBy: ['retries'],
              estimate: 2,
              touches: ['src/webhooks/paid.ts', 'src/email'],
            },
          ],
        },
        {
          id: 'refunds',
          title: 'Refunds and launch',
          goal: 'Admins can refund, and the launch checklist is done.',
          criteria: ['A full and a partial refund work end to end in test mode', 'The launch checklist is ticked'],
          tasks: [
            { id: 'refund-api', title: 'Refund endpoint', issueId: refunds, blockedBy: ['auth', 'retries'], estimate: 3, touches: ['src/refunds'] },
            { id: 'refund-button', title: 'Refund button in the admin', goal: 'A refund button on an order’s admin page, for all or part of it.', acceptance: ['Partial amounts are validated', 'The order shows its refunds'], blockedBy: ['refund-api'], estimate: 2, touches: ['admin/orders'] },
            { id: 'launch-checklist', title: 'Launch checklist', goal: 'Live keys, webhook endpoint registered, alerts on failed payments.', acceptance: ['Live keys in the keychain', 'Webhook endpoint registered in Stripe', 'An alert fires on a failed payment'], assignee: 'me', estimate: 1 },
          ],
        },
      ],
      // Settled while planning (BLG-8): what you answered, and what Claude chose without asking.
      decisions: [
        { question: 'Hosted Stripe Checkout, or the embedded Payment Element?', answer: 'Hosted Checkout', why: 'Least code to keep safe for launch; the embedded form can come later', by: 'user', tasks: ['auth'] },
        { question: 'Can admins refund part of an order?', answer: 'Yes, any amount up to what was paid', by: 'user', tasks: ['refund-api', 'refund-button'] },
        { question: 'How long are handled webhook ids kept?', answer: '30 days', why: 'Stripe retries for up to 3 days; 30 leaves room', tasks: ['retries'] },
        { question: 'Where do the test fixtures live?', answer: 'test/fixtures/stripe', why: 'Next to the other fixtures', tasks: ['fixtures'] },
      ],
    },
    claude,
  );
  travel(3 * DAY + 20 * HOUR);
  work.approve(plan.id);
  travel(2 * DAY + 16 * HOUR);
  // Its checker (a Claude of its own) said why it passes; passing archives that conversation, kept for Open the Check.
  const checked = Date.now() - 2 * DAY - 16 * HOUR;
  const checker = await work.checkerFor(api.id, 'Test-mode foundations', (channel): LogItem[] => [
    {
      id: 'demo-plan-check',
      type: 'agent',
      channel,
      subagents: [],
      requestId: 'demo-plan-check',
      owner: selfId,
      ownerName: me,
      requesterName: 'Beluga',
      requester: selfId,
      status: 'done',
      text: 'Both pass criteria hold.\n\n1. `npm test` runs 24 payment tests covering card, 3-D Secure and declined cards.\n2. With the network off, the fixtures load and every payment test passes.',
      steps: [],
      ts: checked - 6 * 60_000,
      endTs: checked,
    },
  ]);
  if (checker) work.plans.setChecker(plan.id, 'foundations', checker);
  work.plans.recordCheck(plan.id, 'foundations', { by: claude, verdict: 'pass', notes: '1. ✓ 24 payment tests cover card, 3-D Secure and declined.\n2. ✓ Ran them with the network off: all pass.' });
  work.pilot.pass(plan.id, 'foundations', board.me());
  travel(0);
}
