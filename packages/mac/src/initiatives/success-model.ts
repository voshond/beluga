import { type SuccessMetric, type SuccessProposal, type SuccessProposalInput } from '@beluga/core/initiatives/success.js';

/** A metric as the proposal editor holds it: its numbers as typed. */
export type MetricEdit = Omit<SuccessMetric, 'baseline' | 'target'> & { readonly baseline: string; readonly target: string };

export const editsOf = (proposal: SuccessProposal): MetricEdit[] => proposal.metrics.map((m) => ({ ...m, baseline: m.baseline === undefined ? '' : String(m.baseline), target: String(m.target) }));

const numberOf = (typed: string): number | undefined => {
  const n = Number(typed.trim().replace(',', '.'));
  return typed.trim() && Number.isFinite(n) ? n : undefined;
};

/** What a metric's numbers say is wrong, or nothing. */
export const editProblem = (edit: MetricEdit): string | undefined => {
  if (numberOf(edit.target) === undefined) return 'The target needs a number';
  if (edit.baseline.trim() && numberOf(edit.baseline) === undefined) return 'The baseline is a number, or empty to work it out from its query';
  if (!edit.source.query.trim() || !edit.baselineQuery.trim()) return 'Both queries need text';
  return undefined;
};

export const proposalOf = (proposal: SuccessProposal, edits: readonly MetricEdit[]): SuccessProposalInput => ({
  ...proposal,
  metrics: edits.map((e) => {
    const baseline = numberOf(e.baseline);
    return { ...e, target: numberOf(e.target) ?? 0, ...(baseline === undefined ? { baseline: undefined } : { baseline }) };
  }),
});

/** A cell of a preview row, short. */
export const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};
