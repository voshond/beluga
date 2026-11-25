import { describe, expect, it } from 'vitest';
import { logStateOf, proofOf, recordMarkdown, suggestionHistory } from '../src/core/initiatives/log.js';
import { type OutboxDraft, SuggestionsSchema, clarifyMessage } from '../src/core/initiatives/model.js';

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
    expect(recordMarkdown(suggestions[2]!, outbox)).toBe('## In scope?\n\nDecided on 2026-11-25\n\n### Decision\n\nNo\n');
    expect(recordMarkdown(suggestions[1]!, outbox)).toContain('- [RUN-203 edited](https://x.atlassian.net/browse/RUN-203)\n- Slack message sent to #run');
  });

  it('asks the chat to clarify with the why', () => {
    expect(clarifyMessage({ id: 5, text: 'Flag the checks', why: 'They are inverted' })).toBe('Clarify suggestion 5: Flag the checks\nWhy: They are inverted');
    expect(clarifyMessage({ id: 5, text: 'Flag the checks' })).toBe('Clarify suggestion 5: Flag the checks');
  });
});
