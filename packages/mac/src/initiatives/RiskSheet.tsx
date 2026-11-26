import { useState } from 'react';
import { RISK_SEVERITIES, RISK_STATES, type Risk, type RiskSeverity, type RiskState } from '@beluga/core/initiatives/risks.js';
import { Field, FormSheet, Popup, TextArea, TextInput } from '../components/FormSheet.js';
import { useInitiativeActions } from './use-initiatives.js';

export const SEVERITY_LABEL: Readonly<Record<RiskSeverity, string>> = { high: 'High', medium: 'Medium', low: 'Low' };

export const RISK_STATE_LABEL: Readonly<Record<RiskState, string>> = { open: 'Open', watching: 'Watching', closed: 'Closed' };

const SEVERITY_OPTIONS = RISK_SEVERITIES.map((value) => ({ value, label: SEVERITY_LABEL[value] }));

const STATE_OPTIONS = RISK_STATES.map((value) => ({ value, label: RISK_STATE_LABEL[value] }));

type RiskSheetProps = {
  readonly slug: string;
  readonly risk?: Risk;
  readonly close: () => void;
};

/** Add a risk, or change one as it shows: what is saved is the owner's, and the check-ins keep it. */
export const RiskSheet = ({ slug, risk, close }: RiskSheetProps) => {
  const a = useInitiativeActions();
  const [title, setTitle] = useState(risk?.title ?? '');
  const [why, setWhy] = useState(risk?.why ?? '');
  const [severity, setSeverity] = useState<RiskSeverity>(risk?.severity ?? 'medium');
  const [state, setState] = useState<RiskState>(risk?.state ?? 'open');
  const [owner, setOwner] = useState(risk?.owner ?? '');
  const [mitigation, setMitigation] = useState(risk?.mitigation ?? '');

  const handleSubmit = async (): Promise<string | void> => {
    const draft = { ...(risk ? { id: risk.id } : {}), title: title.trim(), why: why.trim(), severity, state, owner: owner.trim(), mitigation: mitigation.trim() };
    const saved = await a.act(() => a.api.saveRisk(slug, draft));
    if (!saved) return 'Couldn’t save it: see the message above';
    close();
  };

  return (
    <FormSheet
      title={risk ? `Edit Risk ${risk.id}` : 'Add Risk'}
      icon="alert"
      intro="What could sink this initiative. Your edits stay: the check-in won’t change them."
      submitLabel={risk ? 'Save' : 'Add Risk'}
      canSubmit={Boolean(title.trim())}
      width={540}
      onCancel={close}
      onSubmit={handleSubmit}
    >
      <Field label="Risk" htmlFor="risk-title">
        <TextInput id="risk-title" value={title} onChange={setTitle} maxLength={200} placeholder="Finance may not sign off the Norway tax table in time" data-autofocus />
      </Field>
      <Field label="Why" htmlFor="risk-why">
        <TextArea id="risk-why" value={why} onChange={setWhy} rows={3} maxLength={2000} placeholder="What makes it likely, and what it would cost" />
      </Field>
      <Field label="Severity" htmlFor="risk-severity">
        <Popup id="risk-severity" label="Severity" value={severity} options={SEVERITY_OPTIONS} onChange={setSeverity} />
      </Field>
      <Field label="State" htmlFor="risk-state">
        <Popup id="risk-state" label="State" value={state} options={STATE_OPTIONS} onChange={setState} />
      </Field>
      <Field label="Owner" htmlFor="risk-owner">
        <TextInput id="risk-owner" value={owner} onChange={setOwner} maxLength={120} placeholder="Who watches it" />
      </Field>
      <Field label="Mitigation" htmlFor="risk-mitigation">
        <TextArea id="risk-mitigation" value={mitigation} onChange={setMitigation} rows={2} maxLength={2000} placeholder="What lowers it, or the plan if it happens" />
      </Field>
    </FormSheet>
  );
};
