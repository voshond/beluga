import { type InitiativeView, type OutboxDraft, type Suggestion, targetWords } from './model.js';

export type LogState = 'open' | 'approved' | 'decided' | 'dismissed';

export const LOG_STATE_LABEL: Readonly<Record<LogState, string>> = { open: 'Open', approved: 'Approved', decided: 'Decided', dismissed: 'Dismissed' };

export type LogProof = {
  readonly label: string;
  readonly url?: string;
  readonly from: 'chat' | 'outbox';
};

export const logStateOf = (suggestion: Pick<Suggestion, 'state' | 'answer'>): LogState => {
  if (suggestion.state === 'approved' && suggestion.answer) return 'decided';
  return suggestion.state;
};

export const suggestionHistory = (item: Pick<InitiativeView, 'suggestions'>): Suggestion[] =>
  item.suggestions.filter((s) => s.state !== 'open').sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));

const sentProof = (draft: OutboxDraft): LogProof => ({
  label: `${draft.to.kind === 'slack' ? 'Slack message' : 'Jira comment'} sent to ${targetWords(draft.to)}`,
  from: 'outbox',
});

export const proofOf = (suggestion: Pick<Suggestion, 'id' | 'proof'>, outbox: readonly OutboxDraft[]): LogProof[] => [
  ...(suggestion.proof ?? []).map((p): LogProof => ({ ...p, from: 'chat' })),
  ...outbox.filter((d) => d.suggestion === suggestion.id && d.state === 'sent').map(sentProof),
];

export const dayOfIso = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : '');

export const recordMarkdown = (suggestion: Suggestion, outbox: readonly OutboxDraft[]): string => {
  const state = logStateOf(suggestion);
  const proof = proofOf(suggestion, outbox);
  const lines = [
    `## ${suggestion.text}`,
    '',
    `${LOG_STATE_LABEL[state]}${suggestion.resolvedAt ? ` on ${dayOfIso(suggestion.resolvedAt)}` : ''}`,
    ...(suggestion.why ? ['', '### Context', '', suggestion.why] : []),
    ...(suggestion.answer ? ['', '### Decision', '', suggestion.answer] : []),
    ...(suggestion.outcome ? ['', '### Outcome', '', suggestion.outcome] : []),
    ...(proof.length ? ['', '### Proof', '', ...proof.map((p) => (p.url ? `- [${p.label}](${p.url})` : `- ${p.label}`))] : []),
  ];
  return `${lines.join('\n')}\n`;
};
