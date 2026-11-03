import { viewBlock } from '../shared/view-spec.js';

/**
 * The demo's live elements (`beluga demo`, screenshots, e2e/views.spec.ts): a payments dashboard
 * with stat tiles, a chart, a table that pages a command's output, code and a palette.
 */

const days = Array.from({ length: 21 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 1 + i));
  const wave = Math.sin(i / 2.6);
  return { day: d.toISOString().slice(0, 10), card: Math.round(420 + i * 9 + wave * 60), wallet: Math.round(180 + i * 6 + Math.cos(i / 3) * 40), failed: Math.round(22 + wave * 9 + (i % 4)) };
});

export const DEMO_STATS = {
  type: 'stats',
  title: 'Payments this week',
  items: [
    { label: 'Revenue', value: 48210, type: 'currency', delta: '+12.4%', deltaLabel: 'vs last week', trend: days.map((d) => d.card + d.wallet) },
    { label: 'Payments', value: 3184, delta: 8.1, deltaLabel: 'vs last week', trend: days.map((d) => d.card) },
    { label: 'Failed', value: 2.3, unit: '%', delta: '-0.6%', invert: true, trend: days.map((d) => d.failed), status: 'good' },
    { label: 'p95 checkout', value: 412, unit: 'ms', delta: '+38', invert: true, deltaLabel: 'slower', status: 'warning' },
  ],
};

export const DEMO_CHART = { type: 'chart', chart: 'area', title: 'Payments per day', summary: 'Card and wallet, October', x: 'day', y: [{ key: 'card', label: 'Card' }, { key: 'wallet', label: 'Wallet' }], curve: 'smooth', data: days.map(({ day, card, wallet }) => ({ day, card, wallet })) };

/** A command that pages itself ({{offset}}, {{limit}}): every page is made when it's asked for. */
const ORDERS_COMMAND =
  'seq $(({{offset}}+1)) $(({{offset}}+{{limit}})) | awk \'{ s = ($1 % 7 == 0) ? "failed" : (($1 % 5 == 0) ? "refunded" : "paid"); printf "{\\"id\\":%d,\\"customer\\":\\"customer-%03d@example.com\\",\\"amount\\":%.2f,\\"status\\":\\"%s\\",\\"created_at\\":\\"2026-10-%02dT%02d:%02d:00Z\\"}\\n", 1000+$1, $1, ($1*37)%480+19.99, s, 22-($1%21), ($1*7)%24, ($1*13)%60 }\'';

export const DEMO_TABLE = {
  type: 'table',
  title: 'Latest orders',
  summary: 'Paged straight from the source: next page, sort and search run without Claude',
  columns: [{ key: 'id', label: 'Order' }, { key: 'customer', type: 'text' }, { key: 'amount', type: 'currency' }, { key: 'status', type: 'badge' }, { key: 'created_at', label: 'Created', type: 'datetime' }],
  source: { kind: 'command', command: ORDERS_COMMAND, format: 'jsonl' },
  pageSize: 8,
};

export const DEMO_BREAKDOWN = {
  type: 'table',
  title: 'Failures by reason',
  data: [
    { reason: 'card_declined', count: 412, share: 0.46 },
    { reason: 'insufficient_funds', count: 221, share: 0.25 },
    { reason: 'expired_card', count: 118, share: 0.13 },
    { reason: 'processing_error', count: 86, share: 0.1 },
    { reason: 'authentication_required', count: 54, share: 0.06 },
  ],
  columns: [{ key: 'reason', type: 'code' }, { key: 'count' }, { key: 'share', type: 'percent' }],
};

const REGIONS = ['EU', 'US', 'APAC', 'LATAM'];
const NAMES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark', 'Wayne', 'Wonka', 'Tyrell', 'Cyberdyne', 'Soylent', 'Aperture', 'Vandelay', 'Pied Piper', 'Massive', 'Oscorp', 'Gringotts', 'Monarch'];

/** Claude set the controls up once: Top 5, Bottom 5, a region, a minimum, overdue only, search. */
export const DEMO_CUSTOMERS = {
  type: 'table',
  title: 'Customers by revenue',
  summary: 'Pick a view: nothing goes back to Claude',
  data: NAMES.map((name, i) => ({ customer: name, region: REGIONS[(i * 7) % 4], revenue: Math.round(((i * 7919) % 9000) + 800), orders: 3 + ((i * 13) % 40), status: i % 6 === 0 ? 'overdue' : 'paid' })),
  columns: [{ key: 'customer' }, { key: 'region', type: 'badge' }, { key: 'revenue', type: 'currency' }, { key: 'orders' }, { key: 'status', type: 'badge' }],
  initial: { sort: '-revenue' },
  pageSize: 8,
  controls: [
    { id: 'rank', type: 'buttons', options: [{ label: 'Top 5', sort: '-revenue', top: 5 }, { label: 'Bottom 5', sort: 'revenue', top: 5 }, { label: 'All' }], default: 'All' },
    { id: 'region', type: 'select', label: 'Region', column: 'region' },
    { id: 'min', type: 'number', label: 'Min revenue', column: 'revenue', op: 'gte' },
    { id: 'late', type: 'toggle', label: 'Overdue only', where: [{ key: 'status', value: 'overdue' }] },
  ],
};

export const DEMO_CODE = {
  type: 'code',
  language: 'ts',
  filename: 'src/webhooks.ts',
  startLine: 18,
  highlight: [22, 23],
  code: [
    "app.post('/webhooks/stripe', async (req, res) => {",
    '  const event = stripe.webhooks.constructEvent(req.body, req.headers[\'stripe-signature\'], secret);',
    "  if (event.type !== 'payment_intent.succeeded') return res.sendStatus(200);",
    '  const intent = event.data.object;',
    '  // Not idempotent: a retried event marks the order paid (and emails) twice.',
    "  await db.query('UPDATE orders SET status = $1 WHERE stripe_intent = $2', ['paid', intent.id]);",
    '  await sendReceipt(intent.customer);',
    '  res.sendStatus(200);',
    '});',
  ].join('\n'),
};

export const DEMO_COLORS = {
  type: 'colors',
  title: 'Checkout palette',
  summary: 'Pick, then send them back',
  pick: true,
  swatches: [
    { name: 'Primary', value: '#2a78d6' },
    { name: 'Success', value: '#1baf7a' },
    { name: 'Warning', value: '#eda100' },
    { name: 'Danger', value: '#e34948' },
    { name: 'Ink', value: '#1d1d1f' },
  ],
};

export const MOCK_VIEWS_ANSWER = [
  'Here’s the payments dashboard. Failures are down `delta:-0.6% good`, but checkout got slower `delta:+38ms bad` `spark:360,371,380,402,412` this week. The webhook fix is `badge:in review` and the launch checklist is at `progress:5/8`.',
  '',
  viewBlock(DEMO_STATS),
  '',
  viewBlock(DEMO_CHART),
  '',
  'The latest orders come straight from the source, so you can page, sort and search them:',
  '',
  viewBlock(DEMO_TABLE),
  '',
  viewBlock(DEMO_BREAKDOWN),
  '',
  'Your biggest customers, with the views you’ll probably want next:',
  '',
  viewBlock(DEMO_CUSTOMERS),
  '',
  'And the plain comparison, as a regular Markdown table:',
  '',
  '| Provider | Success rate | p95 | Fee |',
  '|---|---|---|---|',
  '| Stripe | 97.7% | 412 ms | $0.30 |',
  '| Adyen | 98.1% | 388 ms | $0.25 |',
  '| PayPal | 95.2% | 640 ms | $0.49 |',
  '| Square | 96.4% | 455 ms | $0.30 |',
  '| Braintree | 97.2% | 430 ms | $0.49 |',
  '| Mollie | 96.9% | 470 ms | $0.29 |',
  '| Checkout.com | 97.9% | 401 ms | $0.27 |',
  '| Klarna | 95.8% | 512 ms | $0.35 |',
  '| GoCardless | 96.1% | 590 ms | $0.20 |',
  '',
  'The double-charge comes from here (deployed `time:2026-10-22T09:30:00Z`; reproduce it with `kbd:cmd+shift+r` on the checkout page):',
  '',
  viewBlock(DEMO_CODE),
  '',
  'The checkout button uses `#2a78d6` on `#ffffff`; the whole palette is `colors:#2a78d6,#1baf7a,#eda100,#e34948,#1d1d1f`. Pick new ones here:',
  '',
  viewBlock(DEMO_COLORS),
].join('\n');
