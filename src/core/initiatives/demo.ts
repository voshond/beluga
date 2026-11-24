import path from 'node:path';
import { writeText } from './files.js';
import type { Initiatives } from './initiatives.js';
import type { EpicStatus, EpicTickets, InitiativeDraft, Suggestion } from './model.js';
import { dayOf } from './repo.js';

type DemoInitiative = {
  readonly draft: InitiativeDraft;
  readonly status: EpicStatus;
  readonly tickets: EpicTickets;
  readonly brief: string;
  readonly decisions: string;
  readonly timeline: readonly string[];
  readonly suggestions: readonly Suggestion[];
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
        tickets: [
          { key: 'SHOP-141', url: 'https://example.atlassian.net/browse/SHOP-141', summary: 'Tax rates for Norway', status: 'Blocked', statusCategory: 'inProgress', assignee: 'Ana Ruiz', updated: at(4), epic: 'SHOP-120', prs: [] },
          { key: 'SHOP-150', url: 'https://example.atlassian.net/browse/SHOP-150', summary: '3DS challenge fails on Safari', status: 'In Review', statusCategory: 'inProgress', assignee: undefined, updated: at(1), epic: 'SHOP-120', prs: [{ url: 'https://github.com/example/shop/pull/412', number: 412, state: 'open', repo: 'example/shop', title: 'Retry the 3DS frame on Safari' }] },
          { key: 'SHOP-152', url: 'https://example.atlassian.net/browse/SHOP-152', summary: 'Address lookup falls back to manual entry', status: 'To Do', statusCategory: 'todo', assignee: 'Jonas Berg', updated: at(6), epic: 'SHOP-120', prs: [] },
          { key: 'SHOP-133', url: 'https://example.atlassian.net/browse/SHOP-133', summary: 'Apple Pay button on the one-page form', status: 'Done', statusCategory: 'done', assignee: 'Mia Chen', updated: at(2), epic: 'SHOP-120', prs: [{ url: 'https://github.com/example/shop/pull/398', number: 398, state: 'merged', repo: 'example/shop', title: 'Apple Pay on one page' }] },
        ],
      },
      status: { at: iso, total: 34, done: 21, inProgress: 7, blocked: 2, stale: 3, epics: [{ key: 'SHOP-120', title: 'One-page checkout', total: 34, done: 21, inProgress: 7, blocked: 2, stale: 3 }] },
      brief: '# Checkout v2\n\nOn track for the freeze, with two blockers.\n\n## Where it stands\n\n- 21 of 34 tickets done; payments and address lookup are in review.\n- Blocked: SHOP-141 (tax rates for NO) and SHOP-150 (3DS on Safari).\n- Next: the go/no-go on Thursday.\n',
      decisions: `# Decisions\n\n## Open\n\n- Launch in Norway with the old tax table, or wait for SHOP-141?\n- Keep guest checkout behind a flag for the first week?\n\n## Decided\n\n- ${day(6)}: Apple Pay ships in v2, Google Pay after. Why: one SDK update fewer before the freeze.\n`,
      timeline: [`${day(0)}: check-in: 3 tickets done, SHOP-150 blocked on Safari`, `${day(2)}: design review signed off the address form`, `${day(6)}: decided Apple Pay first`],
      suggestions: [
        { id: 1, text: 'Ask in #checkout-v2 who owns SHOP-150 now that Ana is out', why: 'It has been blocked for 4 days with nobody assigned', kind: 'slack', state: 'open', createdAt: iso },
        { id: 2, text: 'Add the Norway tax question to Thursday’s go/no-go agenda', why: 'It is the last open decision before launch', kind: 'calendar', state: 'open', createdAt: iso },
      ],
    },
    {
      draft: { name: 'Mobile Onboarding', goal: 'Cut the time to a first saved list from 6 minutes to under 2.', epics: ['APP-88', 'APP-91'], slack: [{ ref: '#onboarding' }], docs: [], meetings: [{ match: 'Onboarding' }], repos: [] },
      tickets: {
        at: new Date(now - 3 * DAY).toISOString(),
        tickets: [
          { key: 'APP-93', url: 'https://example.atlassian.net/browse/APP-93', summary: 'Skip button on the welcome carousel', status: 'In Progress', statusCategory: 'inProgress', assignee: 'Sam Okafor', updated: at(3), epic: 'APP-88', prs: [{ url: 'https://github.com/example/app/pull/77', number: 77, state: 'draft', repo: 'example/app', title: 'Welcome: skip' }] },
          { key: 'APP-90', url: 'https://example.atlassian.net/browse/APP-90', summary: 'New welcome copy', status: 'Done', statusCategory: 'done', assignee: 'Sam Okafor', updated: at(8), epic: 'APP-88', prs: [] },
          { key: 'APP-97', url: 'https://example.atlassian.net/browse/APP-97', summary: 'Sample-list picker', status: 'To Do', statusCategory: 'todo', assignee: undefined, updated: at(10), epic: 'APP-91', prs: [] },
        ],
      },
      status: { at: new Date(now - 3 * DAY).toISOString(), total: 18, done: 5, inProgress: 4, blocked: 0, stale: 6, epics: [{ key: 'APP-88', title: 'New welcome flow', total: 11, done: 4, inProgress: 3, blocked: 0, stale: 2 }, { key: 'APP-91', title: 'Sample lists', total: 7, done: 1, inProgress: 1, blocked: 0, stale: 4 }] },
      brief: '# Mobile Onboarding\n\nEarly. The welcome flow is moving; sample lists stalled.\n\n## Where it stands\n\n- 5 of 18 tickets done.\n- 6 tickets untouched for a week, mostly in APP-91.\n',
      decisions: '# Decisions\n\n## Open\n\n- Who owns sample lists now that the content team moved?\n\n## Decided\n',
      timeline: [`${day(3)}: check-in: sample lists stalled`, `${day(9)}: kickoff`],
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
    writeText(path.join(folder, 'sources', 'jira.md'), `# Jira\n\n${demo.status.epics.map((e) => `- ${e.key} ${e.title ?? ''}: ${e.done}/${e.total} done`).join('\n')}\n`);
    initiatives.refresh(slug);
  }
};
