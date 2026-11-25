import { describe, expect, it } from 'vitest';
import { type SourceContext, linkParts, logStateOf, proofOf, recordMarkdown, sourcesOf, suggestionHistory, ticketKeysIn } from '../src/core/initiatives/log.js';
import { type OutboxDraft, SuggestionsSchema, TicketsSchema, clarifyMessage } from '../src/core/initiatives/model.js';

const suggestions = SuggestionsSchema.parse([
  { id: 1, text: 'Ask Ana', state: 'open' },
  { id: 2, text: 'Update RUN-203', state: 'approved', resolvedAt: '2026-11-24T08:00:00Z', outcome: 'Rewritten', proof: [{ label: 'RUN-203 edited', url: 'https://x.atlassian.net/browse/RUN-203' }] },
  { id: 3, text: 'In scope?', kind: 'decision', options: ['Yes', 'No'], state: 'approved', answer: 'No', resolvedAt: '2026-11-25T08:00:00Z' },
  { id: 4, text: 'Ping Finance', state: 'dismissed' },
]);

const outbox: OutboxDraft[] = [
  { id: 1, to: { kind: 'slack', channel: 'C1', label: '#run' }, text: 'hi', suggestion: 2, state: 'sent' },
  { id: 2, to: { kind: 'jira', issue: 'RUN-203' }, text: 'draft', suggestion: 2, state: 'draft' },
];

const bare: SourceContext = { epics: [], docs: [], slack: [], outbox: [] };

const item: SourceContext = {
  epics: ['RUN-1'],
  tickets: TicketsSchema.parse({ at: 'x', tickets: [{ key: 'RUN-89', summary: 'Separate invoice', url: 'https://acme.atlassian.net/browse/RUN-89' }] }),
  docs: [{ ref: 'https://docs.google.com/document/d/abcdefghijkl/edit', label: 'Rollback spec', kind: 'gdoc' }],
  slack: [{ ref: 'https://acme.slack.com/archives/C1', label: 'Sales <> Product' }],
  outbox: [],
};

describe('the sources of a suggestion', () => {
  it('reads ticket keys of known projects, shorthand included', () => {
    const runs = new Set(['RUN']);
    expect(ticketKeysIn('Update RUN-203 (and RUN-204/205), not UTF-8', runs)).toEqual(['RUN-203', 'RUN-204', 'RUN-205']);
    expect(ticketKeysIn('RUN-196/197 vs RUN-195.', runs)).toEqual(['RUN-196', 'RUN-197', 'RUN-195']);
  });

  it('links the named sources, then tickets, links, docs and channels the words mention', () => {
    const suggestion = {
      text: 'Answer on RUN-89 and add it to RUN-199.',
      why: 'See the rollback spec and https://example.com/notes. Ask in Sales <> Product.',
      sources: [{ label: 'Steve’s question', url: 'https://acme.slack.com/archives/C1/p1700000000000' }],
    };
    expect(sourcesOf(suggestion, item)).toEqual([
      { label: 'Steve’s question', url: 'https://acme.slack.com/archives/C1/p1700000000000' },
      { label: 'RUN-89 · Separate invoice', url: 'https://acme.atlassian.net/browse/RUN-89' },
      { label: 'RUN-199', url: 'https://acme.atlassian.net/browse/RUN-199' },
      { label: 'https://example.com/notes', url: 'https://example.com/notes' },
      { label: 'Rollback spec', url: 'https://docs.google.com/document/d/abcdefghijkl/edit' },
      { label: 'Sales <> Product', url: 'https://acme.slack.com/archives/C1' },
    ]);
  });

  it('lists each source once and leaves out keys of other projects', () => {
    expect(sourcesOf({ text: 'RUN-89, RUN-89 and ISO-8601', why: 'https://acme.atlassian.net/browse/RUN-89' }, item)).toEqual([
      { label: 'RUN-89 · Separate invoice', url: 'https://acme.atlassian.net/browse/RUN-89' },
    ]);
  });
});

describe('the decision log', () => {
  it('keeps resolved suggestions, the latest first and undated ones last', () => {
    expect(suggestionHistory({ suggestions }).map((s) => s.id)).toEqual([3, 2, 4]);
  });

  it('tells a decision from an approval', () => {
    expect(suggestions.map(logStateOf)).toEqual(['open', 'approved', 'decided', 'dismissed']);
  });

  it('takes proof from the chat and from drafts the user sent, never unsent ones', () => {
    expect(proofOf(suggestions[1]!, outbox)).toEqual([
      { label: 'RUN-203 edited', url: 'https://x.atlassian.net/browse/RUN-203', from: 'chat' },
      { label: 'Slack message sent to #run', from: 'outbox' },
    ]);
    expect(proofOf(suggestions[2]!, outbox)).toEqual([]);
  });

  it('writes a record as Markdown', () => {
    expect(recordMarkdown(suggestions[2]!, { ...bare, outbox })).toBe('## In scope?\n\nDecided on 2026-11-25\n\n### Decision\n\nNo\n');
    expect(recordMarkdown(suggestions[1]!, { ...bare, outbox })).toContain('- [RUN-203 edited](https://x.atlassian.net/browse/RUN-203)\n- Slack message sent to #run');
    expect(recordMarkdown(suggestions[1]!, { ...item, outbox })).toContain('### Sources\n\n- [RUN-203](https://acme.atlassian.net/browse/RUN-203)');
  });

  it('asks the chat to clarify with the why', () => {
    expect(clarifyMessage({ id: 5, text: 'Flag the checks', why: 'They are inverted' })).toBe('Clarify suggestion 5: Flag the checks\nWhy: They are inverted');
    expect(clarifyMessage({ id: 5, text: 'Flag the checks' })).toBe('Clarify suggestion 5: Flag the checks');
  });
});

describe('links inside a timeline line', () => {
  it('links tickets of known projects in place, a range as one link each, and leaves invoice numbers alone', () => {
    expect(linkParts('RUN-89/90 done, R-2026-04040 / CP-2026-00982 stay', item)).toEqual([
      { text: 'RUN-89', url: 'https://acme.atlassian.net/browse/RUN-89', kind: 'ticket', title: 'RUN-89 · Separate invoice' },
      { text: '/' },
      { text: '90', url: 'https://acme.atlassian.net/browse/RUN-90', kind: 'ticket', title: 'RUN-90' },
      { text: ' done, R-2026-04040 / CP-2026-00982 stay' },
    ]);
  });

  it('links the docs and channels it names, and bare links by their name or host', () => {
    expect(linkParts('Read the rollback spec, asked in Sales <> Product, see https://example.com/notes.', item)).toEqual([
      { text: 'Read the ' },
      { text: 'rollback spec', url: 'https://docs.google.com/document/d/abcdefghijkl/edit', kind: 'doc', title: 'Rollback spec' },
      { text: ', asked in ' },
      { text: 'Sales <> Product', url: 'https://acme.slack.com/archives/C1', kind: 'slack', title: 'Sales <> Product' },
      { text: ', see ' },
      { text: 'example.com', url: 'https://example.com/notes', kind: 'link', title: 'https://example.com/notes' },
      { text: '.' },
    ]);
  });

  it('keeps a line with nothing to link as it is', () => {
    expect(linkParts('initiative created', bare)).toEqual([{ text: 'initiative created' }]);
  });
});
