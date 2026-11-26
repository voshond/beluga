import type { EnrichProposal } from './enrichment.js';
import type { Person } from './people.js';

const handleOf = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '.');

/** What the demo agent finds for each person: their Slack handle (a correction when the entry has a short one), Jira account, email and GitHub. */
export const demoEnrichment = (people: readonly Person[]): EnrichProposal[] =>
  people.flatMap((p, i): EnrichProposal[] => {
    const handle = handleOf(p.name);
    const found: EnrichProposal[] = [
      { person: p.slug, field: 'slack', value: handle, source: 'slack', why: 'Same full name in Slack' },
      { person: p.slug, field: 'slackId', value: `U0DEMO${String(i + 1).padStart(3, '0')}`, source: 'slack', why: 'Same full name in Slack' },
      { person: p.slug, field: 'email', value: `${handle}@example.com`, source: 'slack', why: 'Their Slack profile' },
      { person: p.slug, field: 'jiraId', value: `712020:demo-${p.slug}`, source: 'jira', why: 'Assignable in SHOP with the same name' },
      { person: p.slug, field: 'github', value: handle.replace(/\./g, '-'), source: 'github', why: 'Member of example with the same name' },
    ];
    return found.filter((f) => f.field === 'slack' || !p[f.field]);
  });
