import type { DemoInitiative } from './demo.js';
import { dayOf } from './repo.js';

const DAY = 24 * 60 * 60 * 1000;

const SIZING = `# How many orders ask for a return by email?

About 1,840 a month (last 90 days): 6.1% of delivered orders, and 71% of all return requests. Each takes support 9 minutes on average.

Counts orders with a return request in Zendesk tagged \`return\`, joined to delivered orders; leaves out marketplace orders.

\`\`\`sql
SELECT COUNT(DISTINCT t.order_id) / 3 AS per_month
FROM \`shop.support.tickets\` t
JOIN \`shop.orders.delivered\` o USING (order_id)
WHERE t.created_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
  AND 'return' IN UNNEST(t.tags)
  AND o.channel != 'marketplace'
\`\`\`
`;

const PROOF = '# Returns demo: walkthrough\n\n- Order page › Return an item › pick a reason › label as PDF: 4 clicks\n- Hardcoded orders, no carrier call: the label is a sample\n- Preview: https://returns-demo.example.dev\n';

export const DISCOVERY_DEMO = (now: number): DemoInitiative => {
  const at = (back: number): string => new Date(now - back * DAY).toISOString();
  const day = (back: number): string => dayOf(now - back * DAY);
  return {
    draft: { name: 'Self-serve Returns', status: 'discovery', goal: 'Let customers return an item themselves, without writing to support.\n\n## Open questions\n\n- Do we pay the return shipping in every market?', slack: [{ ref: '#returns' }], docs: [], meetings: [{ match: 'Returns' }], repos: [] },
    brief: '# Self-serve Returns\n\nIn discovery: the problem is clear and sized; the PRD is drafted and the demo is being built.\n',
    decisions: '# Decisions\n\n## Open\n\n- Do we pay the return shipping in every market?\n\n## Decided\n',
    timeline: [`${day(0)} [artifact]: sizing: 1,840 return emails a month`, `${day(1)} [doc]: PRD drafted`, `${day(4)} [created]: initiative created`],
    suggestions: [{ id: 1, text: 'Start the demo task WEB-12 in web?', why: 'The brief is written; stakeholders meet on Thursday', kind: 'decision', options: ['Start it', 'Not yet'], state: 'open', createdAt: at(0) }],
    files: {
      'problem.md': '# Problem\n\nCustomers who want to return an item have to email support. Support answers by hand, prints a label and tracks the refund in a sheet. It is slow for the customer (2 days to a label) and costs support a day a week.\n',
      'evidence.md': '# Evidence\n\n- 1,840 return emails a month, 71% of all return requests (artifact: sizing).\n- “Where is my label?” is the second most common follow-up (Zendesk, last quarter).\n- Two competitors offer returns in the account page (support’s notes in #returns).\n',
      'prd.md': '# PRD: Self-serve Returns\n\n## Problem\n\nReturns go through support by email.\n\n## Goals\n\n- A customer gets a label in under a minute.\n- Support handles only the exceptions.\n\n## Non-goals\n\n- Exchanges, refunds to store credit.\n\n## Success\n\n- Return emails down by half within two months.\n',
      'demo.json': `${JSON.stringify({ repo: 'web', task: 'WEB-12', title: 'Returns demo', state: 'started' }, null, 2)}\n`,
      'proposal.json': `${JSON.stringify({ at: at(0), epics: [{ title: 'Returns in the account page', why: 'The flow the demo shows', key: 'RET-1', stories: [{ title: 'Pick an item and a reason' }, { title: 'Label as PDF' }] }, { title: 'Refund tracking for support', why: 'Support still needs the exceptions', stories: [{ title: 'Exceptions queue' }] }] }, null, 2)}\n`,
      'artifacts/1-return-emails.md': SIZING,
      'artifacts/2-returns-demo.md': PROOF,
    },
    artifacts: [
      { id: 1, title: 'How many orders ask for a return by email?', why: 'A sizing finding, with its query', file: 'artifacts/1-return-emails.md', path: undefined, name: 'return-emails.md', bytes: SIZING.length, ticket: undefined, worktree: undefined, project: undefined, from: 'Size It', about: 'sizing', createdAt: at(0) },
      { id: 2, title: 'Returns demo: walkthrough', why: 'What stakeholders will click through', file: 'artifacts/2-returns-demo.md', path: undefined, name: 'returns-demo.md', bytes: PROOF.length, ticket: 'WEB-12', worktree: 'web-12-returns-demo', project: 'web', from: undefined, about: 'demo', createdAt: at(0) },
    ],
  };
};
