import path from 'node:path';
import { writeText } from './files.js';
import type { Initiatives } from './initiatives.js';
import type { EpicStatus, EpicTickets, InitiativeDraft, InitiativeTasks, OutboxDraft, Suggestion } from './model.js';
import { dayOf } from './repo.js';

type DemoInitiative = {
  readonly draft: InitiativeDraft;
  readonly status: EpicStatus;
  readonly tickets: EpicTickets;
  readonly tasks?: InitiativeTasks;
  readonly brief: string;
  readonly decisions: string;
  readonly timeline: readonly string[];
  readonly suggestions: readonly Suggestion[];
  readonly outbox?: readonly OutboxDraft[];
};

const DAY = 24 * 60 * 60 * 1000;

const demos = (now: number): DemoInitiative[] => {
  const iso = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const day = (back: number): string => dayOf(now - back * DAY);
  const at = (back: number): string => new Date(now - back * DAY).toISOString();
  return [
    {
      draft: { name: 'Checkout v2', goal: 'Ship the new one-page checkout to every market before the holiday freeze.\n\n## Scope\n\n- In: cards, Apple Pay, address lookup\n- Out: Google Pay (after the freeze)\n\n## Acceptance\n\n- Live in every market\n- Conversion no worse than the old flow', epics: ['SHOP-120'], slack: [{ ref: '#checkout-v2' }, { ref: 'https://example.slack.com/archives/C0CHECKOUT/p1763990000000100', label: '3DS on Safari' }], docs: [{ ref: 'https://acme.atlassian.net/wiki/spaces/SHOP/pages/2201/Checkout+v2', label: 'Checkout v2 spec', kind: 'confluence' }, { ref: 'https://docs.google.com/spreadsheets/d/1CheckoutRolloutPlan0000/edit', label: 'Rollout plan', kind: 'gsheet' }], meetings: [{ match: 'Checkout' }, { match: 'Go/no-go', label: 'Thursday' }], repos: [] },
      tickets: {
        at: iso,
        epics: [{ key: 'SHOP-120', url: 'https://example.atlassian.net/browse/SHOP-120', title: 'One-page checkout' }],
        tickets: [
          { key: 'SHOP-141', url: 'https://example.atlassian.net/browse/SHOP-141', summary: 'Tax rates for Norway', status: 'Blocked', statusCategory: 'inProgress', assignee: 'Ana Ruiz', updated: at(4), epic: 'SHOP-120', parent: undefined, prs: [] },
          { key: 'SHOP-158', url: 'https://example.atlassian.net/browse/SHOP-158', summary: 'Norway VAT table from finance', status: 'Done', statusCategory: 'done', assignee: 'Ana Ruiz', updated: at(5), epic: 'SHOP-120', parent: 'SHOP-141', prs: [] },
          { key: 'SHOP-159', url: 'https://example.atlassian.net/browse/SHOP-159', summary: 'Show tax per line on the summary', status: 'To Do', statusCategory: 'todo', assignee: 'Ana Ruiz', updated: at(4), epic: 'SHOP-120', parent: 'SHOP-141', prs: [] },
          { key: 'SHOP-150', url: 'https://example.atlassian.net/browse/SHOP-150', summary: '3DS challenge fails on Safari', status: 'In Review', statusCategory: 'inProgress', assignee: undefined, updated: at(1), epic: 'SHOP-120', parent: undefined, prs: [{ url: 'https://github.com/example/shop/pull/412', number: 412, state: 'open', repo: 'example/shop', title: 'Retry the 3DS frame on Safari' }] },
          { key: 'SHOP-152', url: 'https://example.atlassian.net/browse/SHOP-152', summary: 'Address lookup falls back to manual entry', status: 'To Do', statusCategory: 'todo', assignee: 'Jonas Berg', updated: at(6), epic: 'SHOP-120', parent: undefined, prs: [] },
          { key: 'SHOP-133', url: 'https://example.atlassian.net/browse/SHOP-133', summary: 'Apple Pay button on the one-page form', status: 'Done', statusCategory: 'done', assignee: 'Mia Chen', updated: at(2), epic: 'SHOP-120', parent: undefined, prs: [{ url: 'https://github.com/example/shop/pull/398', number: 398, state: 'merged', repo: 'example/shop', title: 'Apple Pay on one page' }] },
        ],
      },
      tasks: {
        at: iso,
        tasks: [
          { id: 'demo-task-1', title: 'Prep the go/no-go deck', notes: 'Norway tax and Safari 3DS on the first slide', list: 'My Tasks', due: undefined, scheduled: at(-2), done: false, pending: undefined, url: undefined },
          { id: 'demo-task-2', title: 'Ask finance for the final NO tax table', notes: undefined, list: 'My Tasks', due: at(-4), scheduled: undefined, done: false, pending: undefined, url: undefined },
          { id: 'demo-task-3', title: 'Review the address form copy', notes: undefined, list: 'My Tasks', due: undefined, scheduled: undefined, done: false, pending: undefined, url: undefined },
          { id: 'demo-task-4', title: 'Book the Thursday go/no-go room', notes: undefined, list: 'My Tasks', due: undefined, scheduled: undefined, done: true, pending: undefined, url: undefined },
        ],
      },
      status: { at: iso, total: 34, done: 21, inProgress: 7, blocked: 2, stale: 3, epics: [{ key: 'SHOP-120', title: 'One-page checkout', total: 34, done: 21, inProgress: 7, blocked: 2, stale: 3 }] },
      brief: '# Checkout v2\n\nOn track for the freeze, with two blockers.\n\n## Where it stands\n\n- 21 of 34 tickets done; payments and address lookup are in review.\n- Blocked: SHOP-141 (tax rates for NO) and SHOP-150 (3DS on Safari).\n- Next: the go/no-go on Thursday.\n',
      decisions: `# Decisions\n\n## Open\n\n- Launch in Norway with the old tax table, or wait for SHOP-141?\n- Keep guest checkout behind a flag for the first week?\n\n## Decided\n\n- ${day(6)}: Apple Pay ships in v2, Google Pay after. Why: one SDK update fewer before the freeze.\n`,
      timeline: [`${day(0)} [check-in]: 3 tickets done, SHOP-150 blocked on Safari`, `${day(2)} [meeting]: design review signed off the address form`, `${day(6)} [decision]: Apple Pay first`],
      suggestions: [
        { id: 1, text: 'Ask in #checkout-v2 who owns SHOP-150 now that Ana is out', why: 'It has been blocked for 4 days with nobody assigned', kind: 'slack', state: 'open', createdAt: iso },
        { id: 2, text: 'Add the Norway tax question to Thursday’s go/no-go agenda', why: 'It is the last open decision before launch', kind: 'calendar', state: 'open', createdAt: iso },
        { id: 3, text: 'Launch in Norway with the old tax table, or wait for SHOP-141?', why: 'Finance answered both ways; the freeze is in 9 days', kind: 'decision', options: ['Launch with the old table', 'Wait for SHOP-141'], state: 'open', createdAt: iso },
        { id: 4, text: 'Move SHOP-133 and SHOP-134 out of the launch epic', why: 'Both are polish; the team agreed they can ship after launch', kind: 'jira', state: 'approved', createdAt: iso, resolvedAt: iso, outcome: 'Both moved to the post-launch epic; the launch count dropped by two.', proof: [{ label: 'SHOP-133 moved to SHOP-200', url: 'https://example.atlassian.net/browse/SHOP-133' }, { label: 'SHOP-134 moved to SHOP-200', url: 'https://example.atlassian.net/browse/SHOP-134' }] },
        { id: 5, text: 'Is Apple Pay in scope for launch?', why: 'Design has it in the mockups, the epic does not', kind: 'decision', options: ['In scope', 'After launch'], answer: 'After launch', state: 'approved', createdAt: iso, resolvedAt: iso, outcome: 'Recorded in decisions.md and posted to #checkout-v2.' },
        { id: 6, text: 'Remind Ana about the Safari repro steps', why: 'SHOP-150 has no repro', kind: 'slack', state: 'dismissed', createdAt: iso, resolvedAt: iso },
      ],
      outbox: [
        { id: 1, to: { kind: 'slack', channel: 'C0CHECKOUT', label: '#checkout-v2' }, text: 'Hey team, with Ana out, who can pick up SHOP-150 (the Safari payment bug)? It has been blocked for 4 days and it is on the launch path.', why: 'From suggestion 1', suggestion: 1, state: 'draft', createdAt: iso },
        { id: 2, to: { kind: 'jira', issue: 'SHOP-150', label: 'Safari payment bug' }, text: 'Still blocked on Safari 17: the payment sheet closes before the token comes back. Looking for an owner in #checkout-v2.', state: 'draft', createdAt: iso },
      ],
    },
    {
      draft: { name: 'Mobile Onboarding', goal: 'Cut the time to a first saved list from 6 minutes to under 2.', epics: ['APP-88', 'APP-91'], slack: [{ ref: '#onboarding' }], docs: [], meetings: [{ match: 'Onboarding' }], repos: [] },
      tickets: {
        at: new Date(now - 3 * DAY).toISOString(),
        epics: [],
        tickets: [
          { key: 'APP-93', url: 'https://example.atlassian.net/browse/APP-93', summary: 'Skip button on the welcome carousel', status: 'In Progress', statusCategory: 'inProgress', assignee: 'Sam Okafor', updated: at(3), epic: 'APP-88', parent: undefined, prs: [{ url: 'https://github.com/example/app/pull/77', number: 77, state: 'draft', repo: 'example/app', title: 'Welcome: skip' }] },
          { key: 'APP-90', url: 'https://example.atlassian.net/browse/APP-90', summary: 'New welcome copy', status: 'Done', statusCategory: 'done', assignee: 'Sam Okafor', updated: at(8), epic: 'APP-88', parent: undefined, prs: [] },
          { key: 'APP-97', url: 'https://example.atlassian.net/browse/APP-97', summary: 'Sample-list picker', status: 'To Do', statusCategory: 'todo', assignee: undefined, updated: at(10), epic: 'APP-91', parent: undefined, prs: [] },
        ],
      },
      status: { at: new Date(now - 3 * DAY).toISOString(), total: 18, done: 5, inProgress: 4, blocked: 0, stale: 6, epics: [{ key: 'APP-88', title: 'New welcome flow', total: 11, done: 4, inProgress: 3, blocked: 0, stale: 2 }, { key: 'APP-91', title: 'Sample lists', total: 7, done: 1, inProgress: 1, blocked: 0, stale: 4 }] },
      brief: '# Mobile Onboarding\n\nEarly. The welcome flow is moving; sample lists stalled.\n\n## Where it stands\n\n- 5 of 18 tickets done.\n- 6 tickets untouched for a week, mostly in APP-91.\n',
      decisions: '# Decisions\n\n## Open\n\n- Who owns sample lists now that the content team moved?\n\n## Decided\n',
      timeline: [`${day(3)} [check-in]: sample lists stalled`, `${day(9)} [meeting]: kickoff`],
      suggestions: [{ id: 1, text: 'Create a task in the app repo to prototype the sample-list picker', why: 'APP-91 has had no movement for a week', kind: 'task', state: 'open', createdAt: iso }],
    },
  ];
};

export const seedDemoInitiatives = async (initiatives: Initiatives, root: string, now: number = Date.now()): Promise<void> => {
  for (const demo of demos(now)) {
    const { slug } = await initiatives.create(demo.draft, { quiet: true });
    const folder = path.join(root, slug);
    writeText(path.join(folder, 'status.json'), `${JSON.stringify(demo.status, null, 2)}\n`);
    writeText(path.join(folder, 'tickets.json'), `${JSON.stringify(demo.tickets, null, 2)}\n`);
    writeText(path.join(folder, 'brief.md'), demo.brief);
    writeText(path.join(folder, 'decisions.md'), demo.decisions);
    writeText(path.join(folder, 'timeline.md'), `# Timeline\n\nNewest first.\n\n${demo.timeline.map((t) => `- ${t}`).join('\n')}\n`);
    writeText(path.join(folder, 'suggestions.json'), `${JSON.stringify(demo.suggestions, null, 2)}\n`);
    if (demo.tasks) writeText(path.join(folder, 'tasks.json'), `${JSON.stringify(demo.tasks, null, 2)}\n`);
    if (demo.outbox) writeText(path.join(folder, 'outbox.json'), `${JSON.stringify(demo.outbox, null, 2)}\n`);
    if (slug === 'checkout-v2') {
      writeText(path.join(folder, 'artifacts', '1-3ds-safari-retry.md'), '# 3DS on Safari: retry check\n\n- 40 test payments on Safari 18, 3DS challenge forced\n- 38 passed on the first frame, 2 after one retry, none failed\n');
      writeText(path.join(folder, 'artifacts.json'), `${JSON.stringify([{ id: 1, title: '3DS on Safari: retry check', why: 'Shows the retry fixes the Safari challenge before SHOP-150 merges.', file: 'artifacts/1-3ds-safari-retry.md', name: '3ds-safari-retry.md', bytes: 140, ticket: 'SHOP-150', worktree: 'shop-150-3ds-retry', project: 'shop', createdAt: new Date(now - 3_600_000).toISOString() }], null, 2)}\n`);
    }
    writeText(path.join(folder, 'sources', 'jira.md'), `# Jira\n\n${demo.status.epics.map((e) => `- ${e.key} ${e.title ?? ''}: ${e.done}/${e.total} done`).join('\n')}\n`);
    initiatives.refresh(slug);
  }
};
