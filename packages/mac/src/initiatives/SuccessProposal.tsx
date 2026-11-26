import { useState } from 'react';
import type { SuccessDraft, SuccessPreview } from '@beluga/core/initiatives/success.js';
import { formatSuccessNumber } from '@beluga/core/initiatives/success.js';
import { Field, TextArea, TextInput } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { Button, Segmented } from '../components/ui.js';
import { type MetricEdit, cellText, editProblem, editsOf, proposalOf } from './success-model.js';
import s from './initiatives.module.css';
import own from './success.module.css';

const DIRECTIONS = [
  { value: 'up' as const, label: 'Higher' },
  { value: 'down' as const, label: 'Lower' },
];

const PreviewRows = ({ preview }: { preview: SuccessPreview | undefined }) => {
  if (!preview) return null;
  if (preview.error)
    return (
      <div className={s.trouble} role="alert">
        <Icon name="alert" size={12} />
        It did not run: {preview.error}
      </div>
    );
  if (!preview.rows.length) return <span className={s.quiet}>No rows came back.</span>;
  return (
    <div className={own.rows}>
      <table aria-label="First rows">
        <thead>
          <tr>
            {preview.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.slice(0, 5).map((row, n) => (
            <tr key={n}>
              {preview.columns.map((c) => (
                <td key={c}>{cellText(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const MetricEditor = ({ edit, preview, onChange }: { edit: MetricEdit; preview: SuccessPreview | undefined; onChange: (next: MetricEdit) => void }) => {
  const put = <K extends keyof MetricEdit>(key: K) => (value: MetricEdit[K]): void => onChange({ ...edit, [key]: value });
  const handleQuery = (query: string): void => onChange({ ...edit, source: { ...edit.source, query } });
  const problem = editProblem(edit);
  return (
    <div className={s.card} data-success-metric={edit.name} aria-label={`Metric ${edit.label}`}>
      <Field label="Metric">
        <TextInput value={edit.label} onChange={put('label')} aria-label="Label" />
      </Field>
      <Field label="Counts" hint={`Filter: ${edit.filter}`}>
        <TextArea value={edit.attribution} onChange={put('attribution')} rows={2} aria-label="Attribution" />
      </Field>
      <Field label="Query" hint={`${edit.source.kind === 'bigquery' ? 'BigQuery' : 'Postgres'}: one row, the number in value`}>
        <TextArea value={edit.source.query} onChange={handleQuery} rows={4} mono aria-label="Query" />
      </Field>
      <Field label="First rows">
        <PreviewRows preview={preview} />
      </Field>
      <Field label="Baseline" hint={edit.baselineWindow || 'The same query before delivery'}>
        <TextInput value={edit.baseline} onChange={put('baseline')} inputMode="decimal" aria-label="Baseline" />
      </Field>
      <Field label="Baseline query">
        <TextArea value={edit.baselineQuery} onChange={put('baselineQuery')} rows={3} mono aria-label="Baseline query" />
      </Field>
      <Field label="Target" hint={preview?.value !== undefined ? `Now: ${formatSuccessNumber(preview.value, edit.unit)}` : undefined} error={problem}>
        <TextInput value={edit.target} onChange={put('target')} inputMode="decimal" aria-label="Target" />
      </Field>
      <Field label="Better">
        <Segmented value={edit.direction} options={DIRECTIONS} onChange={put('direction')} label="Which way is better" size="small" />
      </Field>
    </div>
  );
};

export const SuccessProposalCard = ({ draft, busy, onAccept, onReject }: { draft: SuccessDraft; busy: boolean; onAccept: (proposal: ReturnType<typeof proposalOf>) => void; onReject: () => void }) => {
  const [edits, setEdits] = useState<MetricEdit[]>(() => editsOf(draft.proposal));
  const broken = draft.previews.some((p) => p.error) || edits.some((e) => editProblem(e));
  const handleChange = (at: number) => (next: MetricEdit): void => setEdits((was) => was.map((e, n) => (n === at ? next : e)));
  const handleAccept = (): void => onAccept(proposalOf(draft.proposal, edits));
  return (
    <div className={s.draft} data-success="draft" aria-label="The agent’s proposal of what success means">
      <p className={s.lede}>{draft.proposal.summary}</p>
      {draft.proposal.notes ? <p className={s.quiet}>{draft.proposal.notes}</p> : null}
      {edits.map((edit, n) => (
        <MetricEditor key={edit.name} edit={edit} preview={draft.previews.find((p) => p.metric === edit.name)} onChange={handleChange(n)} />
      ))}
      <span className={s.buttons}>
        <Button size="small" variant="primary" onClick={handleAccept} disabled={busy || edits.some((e) => editProblem(e))}>
          {busy ? 'Checking…' : 'Accept'}
        </Button>
        <Button size="small" variant="quiet" onClick={onReject} disabled={busy}>
          Reject
        </Button>
        {broken ? <span className={s.quiet}>Every query runs again on Accept: nothing is saved while one fails.</span> : null}
      </span>
    </div>
  );
};
