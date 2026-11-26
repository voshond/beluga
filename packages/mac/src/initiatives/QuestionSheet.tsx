import { useState } from 'react';
import { type InitiativeView, targetWords } from '@beluga/core/initiatives/model.js';
import { type Question, questionWatch, QuestionDraftSchema, type QuestionDraft } from '@beluga/core/initiatives/questions.js';
import { EntryText } from './InitiativeTimeline.js';
import { Field, FormSheet, Popup, TextArea, TextInput } from '../components/FormSheet.js';
import { useInitiativeActions } from './use-initiatives.js';

type Props = { readonly question?: Question; readonly item: InitiativeView; readonly close: () => void; readonly openChat: (channel: string) => void; readonly resolving?: boolean };

export const QuestionSheet = ({ question, item, close, openChat, resolving }: Props) => {
  const { api, act } = useInitiativeActions();
  const [text, setText] = useState(question?.text ?? '');
  const [waitingOn, setWaitingOn] = useState(question?.waitingOn ?? '');
  const [action, setAction] = useState(resolving ? 'answer' : 'save');
  const [draft, setDraft] = useState('');
  const [ref, setRef] = useState('');
  const [sentOn, setSentOn] = useState('');
  const [merge, setMerge] = useState('');
  const [answer, setAnswer] = useState('');
  const [source, setSource] = useState('');

  const history = question ? item.watches?.filter((entry) => entry.question === question.id && entry.source) ?? [] : [];
  const watch = question && questionWatch(question.id, item.watches ?? []);
  const drafts = item.outbox.filter((entry) => (entry.to.kind === 'slack' || entry.to.kind === 'jira') && (entry.state === 'sent' || entry.state === 'draft') && (!entry.question || entry.question === question?.id || entry.question === merge) && !entry.reminderFor);
  const duplicates = (item.questions ?? []).filter((entry) => !entry.answer && entry.id !== question?.id);
  const hasPendingDraft = question && item.outbox.some((entry) => entry.question === question.id && (entry.state === 'draft' || entry.state === 'approved'));
  const actions = [
    { value: 'save', label: 'Save question' },
    ...(watch?.state === 'watching' || hasPendingDraft ? [] : [{ value: 'draft', label: 'Draft outreach with agent' }]),
    ...(drafts.length ? [{ value: 'link-draft', label: 'Link an outbox message' }] : []),
    { value: 'link', label: 'Track a message already sent' },
    { value: 'answer', label: 'Record an answer' },
  ];
  const handleMerge = (id: string): void => {
    setDraft('');
    setMerge(id);
  };
  const sentDate = Date.parse(`${sentOn}T00:00:00`);
  const input: QuestionDraft = {
    id: question?.id,
    text,
    waitingOn,
    merge: merge || undefined,
    draft: action === 'link-draft' && draft ? Number(draft) : undefined,
    outreach: action === 'link' && ref.trim() ? { ref, since: Number.isFinite(sentDate) ? new Date(sentDate).toISOString() : undefined } : undefined,
    answer: action === 'answer' && answer.trim() ? { text: answer, source: source.trim() || undefined } : undefined,
  };
  const ready = text.trim() && (action !== 'link' || ref.trim()) && (action !== 'link-draft' || draft) && (action !== 'answer' || answer.trim());
  const handleSubmit = async (): Promise<void | string> => {
    const parsed = QuestionDraftSchema.safeParse(input);
    if (!parsed.success) return action === 'answer' ? 'Use a valid http or https source link.' : 'Check the question details.';
    const saved = await api.saveQuestion(item.slug, parsed.data);
    if (action !== 'draft') {
      close();
      return;
    }
    const result = await act(() => api.draftQuestion(item.slug, saved.id));
    close();
    if (result) openChat(result.channel);
  };
  return (
    <FormSheet title={resolving ? 'Resolve question' : question ? 'Edit question' : 'Add question'} icon="chat" onCancel={close} onSubmit={handleSubmit} canSubmit={Boolean(ready)} submitLabel={action === 'draft' ? 'Save and draft' : resolving ? 'Resolve' : 'Save'}>
      <Field label="Question" htmlFor="initiative-question-text">
        <TextArea id="initiative-question-text" value={text} onChange={setText} maxLength={4000} data-autofocus={!resolving || undefined} />
      </Field>
      <Field label="Who can answer?" htmlFor="initiative-question-person" hint="Separate multiple names with commas.">
        <TextInput id="initiative-question-person" value={waitingOn} onChange={setWaitingOn} maxLength={120} />
      </Field>
      {question && duplicates.length ? (
        <Field label="Merge duplicate" htmlFor="initiative-question-merge" hint="Keep this question and bring over the duplicate’s outreach.">
          <Popup id="initiative-question-merge" label="Merge duplicate" value={merge} onChange={handleMerge} options={[{ value: '', label: 'None' }, ...duplicates.map((entry) => ({ value: entry.id, label: entry.text.slice(0, 120) }))]} />
        </Field>
      ) : null}
      <Field label="Action" htmlFor="initiative-question-action">
        <Popup id="initiative-question-action" label="Action" value={action} onChange={setAction} options={actions} />
      </Field>
      {action === 'link-draft' ? (
        <Field label="Outbox message" htmlFor="initiative-question-draft">
          <Popup id="initiative-question-draft" label="Outbox message" value={draft} onChange={setDraft} options={[{ value: '', label: 'Choose a message' }, ...drafts.map((entry) => ({ value: String(entry.id), label: `${targetWords(entry.to)} · ${entry.text.slice(0, 100)}` }))]} />
        </Field>
      ) : null}
      {action === 'link' ? (
        <>
          <Field label="Where you asked" htmlFor="initiative-question-ref" hint="Paste a Slack message link, Jira comment link, or Jira issue key.">
            <TextInput id="initiative-question-ref" value={ref} onChange={setRef} maxLength={500} />
          </Field>
          <Field label="Date sent" htmlFor="initiative-question-sent" hint="Optional. Slack links include the date.">
            <TextInput type="date" id="initiative-question-sent" value={sentOn} onChange={setSentOn} />
          </Field>
        </>
      ) : null}
      {history.length > 1 ? (
        <ul aria-label="Outreach history">
          {history.map((entry) => <li key={entry.id}>{entry.since.slice(0, 10)} <EntryText text={entry.source ?? ''} item={item} /></li>)}
        </ul>
      ) : null}
      {action === 'answer' ? (
        <>
          <Field label="Answer" htmlFor="initiative-question-answer">
            <TextArea id="initiative-question-answer" value={answer} onChange={setAnswer} maxLength={4000} data-autofocus={resolving || undefined} />
          </Field>
          <Field label="Source link" htmlFor="initiative-question-source" hint="Optional when you enter the answer yourself.">
            <TextInput id="initiative-question-source" value={source} onChange={setSource} maxLength={1000} />
          </Field>
        </>
      ) : null}
    </FormSheet>
  );
};
