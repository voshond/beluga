import { describe, expect, it } from 'vitest';
import { decisionLog, decisionsOf, recordedNotes, settledNotes } from '../src/core/initiatives/decisions.js';
import type { Suggestion } from '../src/core/initiatives/model.js';

const TIDY = `# Decisions

## Open

- 2026-11-25: How many notice emails? Asked Jo, no reply by 2026-11-26.
- 2026-11-26: Who owns the Sales channel?

## Decided

- 2026-11-26: The share charge gets its own invoice ticket. Why: Finance wants a separate invoice.
- 2026-11-25: Only the latest extension can be rolled back. Why: keeps rollback simple. (suggestion 1)
`;

const GROUPED = `# Decisions

## Open

Waiting on stakeholders (Google Task "chase", due 2026-11-27):

- Anything to cover in Salesforce? No answer. (2026-11-20)
- Are verifications removed with the setup? Asked Julia 2026-11-23,
  nudged 2026-11-24.

For the spec with Denis:

- Partial enrollment pricing: whole line or per unit? (raised 2026-11-25)

## Decided

- **2026-11-26: ISO country codes in invoice footers.** Will decide later. Why: nobody answered yet.

- 2026-11-24: Sale Orders are out of scope for the initial delivery and become a follow-up. Why: Martin decided.
`;

const decision = (more: Partial<Suggestion>): Suggestion => ({ id: 1, text: 'Which way?', kind: 'decision', state: 'approved', ...more });

describe('decisions.md', () => {
  it('reads the open questions and the settled ones with their day and reason', () => {
    const notes = decisionsOf(TIDY)!;
    expect(notes.open).toEqual([
      { day: '2026-11-25', text: 'How many notice emails? Asked Jo, no reply by 2026-11-26.' },
      { day: '2026-11-26', text: 'Who owns the Sales channel?' },
    ]);
    expect(notes.decided).toEqual([
      { day: '2026-11-26', text: 'The share charge gets its own invoice ticket.', why: 'Finance wants a separate invoice.' },
      { day: '2026-11-25', text: 'Only the latest extension can be rolled back.', why: 'keeps rollback simple.', suggestion: 1 },
    ]);
  });

  it('forgives what agents already wrote: groups, trailing days, wrapped lines and bold days', () => {
    const notes = decisionsOf(GROUPED)!;
    expect(notes.open).toEqual([
      { day: '2026-11-20', text: 'Anything to cover in Salesforce? No answer.', group: 'Waiting on stakeholders (Google Task "chase", due 2026-11-27)' },
      { day: '', text: 'Are verifications removed with the setup? Asked Julia 2026-11-23, nudged 2026-11-24.', group: 'Waiting on stakeholders (Google Task "chase", due 2026-11-27)' },
      { day: '2026-11-25', text: 'Partial enrollment pricing: whole line or per unit?', group: 'For the spec with Denis' },
    ]);
    expect(notes.decided.map((n) => [n.day, n.text, n.why])).toEqual([
      ['2026-11-26', 'ISO country codes in invoice footers. Will decide later.', 'nobody answered yet.'],
      ['2026-11-24', 'Sale Orders are out of scope for the initial delivery and become a follow-up.', 'Martin decided.'],
    ]);
  });

  it('gives nothing for a file in another shape, so the page only lists it as a memory file', () => {
    expect(decisionsOf('')).toBeUndefined();
    expect(decisionsOf('# Decisions\n\n- we picked Postgres\n\n### Notes\n\nfree text')).toBeUndefined();
    expect(decisionsOf('# Decisions\n\n## Open\n\n## Decided\n')).toEqual({ open: [], decided: [] });
  });
});

describe('the decision log', () => {
  it('leaves out a settled note that records a suggestion it already shows, by its number or by its words and day', () => {
    const sale = decision({ id: 2, text: 'Are Sale Orders in scope?', answer: 'out of scope for initial delivery, but a follow up', resolvedAt: '2026-11-24T21:44:31.531Z' });
    const notes = decisionsOf(GROUPED)!.decided;
    expect([...recordedNotes(notes, [sale])]).toEqual([1]);
    expect([...recordedNotes(notes, [{ ...sale, resolvedAt: '2026-11-20T10:00:00Z' }])]).toEqual([]);
    expect([...recordedNotes(notes, [{ ...sale, state: 'dismissed' }])]).toEqual([]);
    expect([...recordedNotes(notes, [{ ...sale, kind: 'jira', options: undefined }])]).toEqual([]);
    const tidy = decisionsOf(TIDY)!.decided;
    expect([...recordedNotes(tidy, [decision({ id: 1, resolvedAt: '2026-01-01T00:00:00Z' })])]).toEqual([1]);
    expect([...recordedNotes(tidy, [decision({ id: 7 })])]).toEqual([]);
  });

  it('pairs a decision with one note at most, by the words that set it apart', () => {
    const notes = decisionsOf(`## Decided

- 2026-11-24: Rollback window: only the latest extension, while it runs. Why: decided earlier.
- 2026-11-24: Rollback scope: one extension at a time, no multi-cycle rollback. Why: simpler.
- 2026-11-24: The extension cron runs nightly. Why: Steve.
`)!.decided;
    const window = decision({ id: 1, text: 'Which rollback window should apply to an extension?', answer: 'only the latest one, while it runs', resolvedAt: '2026-11-24T10:00:00Z' });
    const scope = decision({ id: 2, text: 'Roll back one extension cycle, or several?', answer: 'one at a time', resolvedAt: '2026-11-24T11:00:00Z' });
    expect([...recordedNotes(notes, [window])]).toEqual([0]);
    expect([...recordedNotes(notes, [window, scope])].sort()).toEqual([0, 1]);
  });

  it('puts resolved suggestions and settled notes together, the latest first', () => {
    const suggestions = [decision({ id: 1, resolvedAt: '2026-11-25T19:07:21Z' }), decision({ id: 3, text: 'Open one', state: 'open' }), decision({ id: 4, text: 'Ping Jo', kind: 'slack', resolvedAt: '2026-11-27T08:00:00Z' })];
    const item = { suggestions, decisions: decisionsOf(TIDY) };
    expect(settledNotes(item).map((n) => n.text)).toEqual(['The share charge gets its own invoice ticket.']);
    expect(decisionLog(item).map((e) => (e.kind === 'suggestion' ? `s${e.suggestion.id}` : e.note.day))).toEqual(['s4', '2026-11-26', 's1']);
    expect(decisionLog({ suggestions })).toHaveLength(2);
  });
});
