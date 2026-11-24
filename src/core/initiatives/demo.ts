import path from 'node:path';
import { writeText } from './files.js';
import type { Initiatives } from './initiatives.js';
import type { EpicStatus, InitiativeDraft, Suggestion } from './model.js';
import { dayOf } from './repo.js';

type DemoInitiative = {
  readonly draft: InitiativeDraft;
  readonly status: EpicStatus;
  readonly brief: string;
  readonly decisions: string;
  readonly timeline: readonly string[];
  readonly suggestions: readonly Suggestion[];
};

const DAY = 24 * 60 * 60 * 1000;

const demos = (now: number): DemoInitiative[] => {
  const iso = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const day = (back: number): string => dayOf(now - back * DAY);
  return [
    {
      draft: { name: 'Checkout v2', goal: 'Ship the new one-page checkout to every market before the holiday freeze.', epics: ['SHOP-120'], slackChannels: ['#checkout-v2'], docs: ['https://docs.example.com/checkout-v2'], calendarMatch: 'Checkout', repos: [] },
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
      draft: { name: 'Mobile Onboarding', goal: 'Cut the time to a first saved list from 6 minutes to under 2.', epics: ['APP-88', 'APP-91'], slackChannels: ['#onboarding'], docs: [], calendarMatch: 'Onboarding', repos: [] },
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
    const { slug } = await initiatives.create(demo.draft);
    const folder = path.join(root, slug);
    writeText(path.join(folder, 'status.json'), `${JSON.stringify(demo.status, null, 2)}\n`);
    writeText(path.join(folder, 'brief.md'), demo.brief);
    writeText(path.join(folder, 'decisions.md'), demo.decisions);
    writeText(path.join(folder, 'timeline.md'), `# Timeline\n\nNewest first.\n\n${demo.timeline.map((t) => `- ${t}`).join('\n')}\n`);
    writeText(path.join(folder, 'suggestions.json'), `${JSON.stringify(demo.suggestions, null, 2)}\n`);
    writeText(path.join(folder, 'sources', 'jira.md'), `# Jira\n\n${demo.status.epics.map((e) => `- ${e.key} ${e.title ?? ''}: ${e.done}/${e.total} done`).join('\n')}\n`);
    initiatives.refresh(slug);
  }
};
