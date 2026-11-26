import type { SuccessProposal, SuccessSource } from './success.js';

/**
 * The demo's success pass (BLG-141): what the mock agent proposes, and a stand-in for BigQuery that
 * answers every query without the network, so Define Success, Accept and the dashboard work offline.
 */

export const demoSuccessProposal = (name: string): SuccessProposal => ({
  summary: `${name} succeeds when more people finish checkout on the new one-page flow, and fewer of them drop at payment. Only orders placed through the one-page flow (checkout_version = 'v2') count as caused by it.`,
  notes: 'The repo names the flag checkout_v2_enabled; BigQuery only has checkout_version on events, so the queries use that.',
  metrics: [
    {
      name: 'conversion',
      label: 'Checkout conversion',
      unit: 'percent',
      direction: 'up',
      source: { kind: 'bigquery', query: "SELECT ROUND(100 * COUNTIF(event = 'order_placed') / COUNTIF(event = 'checkout_started'), 2) AS value FROM `acme.analytics.events` WHERE DATE(ts) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) AND checkout_version = 'v2'" },
      attribution: 'Sessions that started checkout on the one-page flow.',
      filter: "checkout_version = 'v2'",
      baselineQuery: "SELECT ROUND(100 * COUNTIF(event = 'order_placed') / COUNTIF(event = 'checkout_started'), 2) AS value FROM `acme.analytics.events` WHERE DATE(ts) BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 35 DAY) AND DATE_SUB(CURRENT_DATE(), INTERVAL 28 DAY)",
      baselineWindow: 'the week a month ago, before the one-page flow',
      target: 64,
    },
    {
      name: 'payment_drop',
      label: 'Drop-off at payment',
      unit: 'percent',
      direction: 'down',
      source: { kind: 'bigquery', query: "SELECT ROUND(100 * COUNTIF(event = 'payment_abandoned') / COUNTIF(event = 'payment_shown'), 2) AS value FROM `acme.analytics.events` WHERE DATE(ts) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) AND checkout_version = 'v2'" },
      attribution: 'Payment steps shown on the one-page flow.',
      filter: "checkout_version = 'v2'",
      baselineQuery: "SELECT ROUND(100 * COUNTIF(event = 'payment_abandoned') / COUNTIF(event = 'payment_shown'), 2) AS value FROM `acme.analytics.events` WHERE DATE(ts) BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 35 DAY) AND DATE_SUB(CURRENT_DATE(), INTERVAL 28 DAY)",
      baselineWindow: 'the week a month ago, before the one-page flow',
      target: 12,
    },
  ],
});

const hash = (text: string): number => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** A query answered as the demo's BigQuery would: a steady number per query; one naming FAIL fails. */
export const demoPeek = async (source: SuccessSource): Promise<{ readonly columns: readonly string[]; readonly rows: ReadonlyArray<Record<string, unknown>> }> => {
  if (/\bFAIL\b/.test(source.query)) throw new Error('Unrecognized name: FAIL at [1:8]');
  const value = 10 + (hash(source.query) % 6000) / 100;
  const kept = /AS baseline\b/.exec(source.query);
  if (!kept) return { columns: ['value'], rows: [{ value }] };
  const literal = (name: string): number => Number(new RegExp(`(-?[\\d.]+) AS ${name}\\b`).exec(source.query)?.[1] ?? NaN);
  return { columns: ['value', 'baseline', 'target'], rows: [{ value, baseline: literal('baseline'), target: literal('target') }] };
};
