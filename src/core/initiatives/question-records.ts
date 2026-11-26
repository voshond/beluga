import { createHash, randomUUID } from 'node:crypto';
import type { DecisionNote, DecisionNotes } from './decisions.js';
import { writeOutbox, writeQuestions, writeWatches, type InitiativeFolder } from './files.js';
import type { OutboxDraft } from './model.js';
import { waitingQuestionsOf } from './people.js';
import { type Question, type QuestionDraft, QuestionDraftSchema, questionWatch } from './questions.js';
import { slackMessageTime, watchOfDraft, watchPlaceOf, WatchSchema, nextWatchId, type Watch } from './watches.js';

export const isQuestionTarget = (to: OutboxDraft['to']) => to.kind === 'slack' || to.kind === 'jira';

const legacyQuestionId = (text: string): string =>
  `legacy-${createHash('sha256').update(text.trim()).digest('hex').slice(0, 32)}`;

const legacyQuestion = (note: DecisionNote): Question => {
  const waiting = waitingQuestionsOf(`## Open\n- ${note.text}`)[0];
  return {
    id: legacyQuestionId(note.text),
    text: (waiting?.text ?? note.text).slice(0, 4000),
    createdAt: note.day,
    ...(waiting ? { waitingOn: waiting.waitingOn.slice(0, 120) } : {}),
  };
};

export const questionsOf = (folder: InitiativeFolder): Question[] => {
  const stored = new Set(folder.questions.map((question) => question.id));
  const legacy = (folder.decisions?.open ?? []).map(legacyQuestion).filter((question) => {
    if (stored.has(question.id)) return false;
    stored.add(question.id);
    return true;
  });
  return [...folder.questions.filter((question) => !question.mergedInto), ...legacy];
};

export const questionDecisions = (folder: InitiativeFolder): DecisionNotes | undefined => {
  const answered = folder.questions.flatMap((question): DecisionNote[] => question.answer && !question.mergedInto
    ? [{ text: question.text, why: question.answer.text, day: question.answer.at.slice(0, 10), source: question.answer.source, question: true }]
    : []);
  if (!folder.decisions && !answered.length) return undefined;
  const stored = new Set(folder.questions.map((question) => question.id));
  return {
    open: (folder.decisions?.open ?? []).filter((note) => !stored.has(legacyQuestionId(note.text))),
    decided: [...(folder.decisions?.decided ?? []), ...answered],
  };
};

const activeWatch = (watches: readonly Watch[], id: string): Watch | undefined =>
  watches.find((watch) => watch.question === id && watch.state === 'watching');

const watchForQuestion = (watch: Watch, question: Question): Watch => ({
  ...watch,
  question: question.id,
  what: question.text.slice(0, 500),
  waitingOn: question.waitingOn || undefined,
});

export const linkSentQuestionDraft = (watches: readonly Watch[], question: Question, draft: OutboxDraft, now: number): readonly Watch[] => {
  if (question.answer || !isQuestionTarget(draft.to)) return watches;
  const existing = watches.find((watch) => watch.draft === draft.id);
  const live = activeWatch(watches, question.id);
  const fromDraft = watchOfDraft(draft, existing?.id ?? nextWatchId(watches), now);
  const linked = watchForQuestion(existing ? { ...existing, where: fromDraft.where, source: fromDraft.source ?? existing.source } : fromDraft, question);
  const kept: Watch = live && live.id !== linked.id && linked.state === 'watching' ? { ...linked, state: 'stopped' } : linked;
  return existing ? watches.map((watch) => watch.id === existing.id ? kept : watch) : [...watches, kept];
};

const manualWatch = (watches: readonly Watch[], question: Question, outreach: NonNullable<QuestionDraft['outreach']>, now: number): Watch[] => {
  const where = watchPlaceOf(outreach.ref);
  if (!where || (where.kind !== 'slack' && where.kind !== 'jira')) throw new Error('Use a Slack message link or a Jira issue key or comment link');
  if (where.kind === 'slack' && !where.thread) throw new Error('Use a link to the Slack message you sent');
  const posted = /\/p(\d{10})(\d{6})(?:[/?#]|$)/.exec(outreach.ref);
  const messageTime = posted && where.kind === 'slack' ? slackMessageTime(`${posted[1]}.${posted[2]}`) : undefined;
  const since = outreach.since ?? new Date(messageTime ?? now).toISOString();
  if (Date.parse(since) > now) throw new Error('The outreach date must be in the past');
  const source = /^https?:\/\//i.test(outreach.ref) ? outreach.ref : undefined;
  const active = questionWatch(question.id, watches);
  const existing = watches.find((watch) => watch.state === 'watching' && (!watch.question || watch.question === question.id) &&
    (source ? watch.source === source || (where.kind === 'slack' && watch.where.kind === 'slack' && watch.where.channel === where.channel && watch.where.thread === where.thread)
      : watch.id === active?.id && where.kind === 'jira' && watch.where.kind === 'jira' && watch.where.issue === where.issue));
  const watch = watchForQuestion(WatchSchema.parse({ ...existing, id: existing?.id ?? nextWatchId(watches), what: question.text.slice(0, 500), where, source: source ?? existing?.source, since }), question);
  const updated = watches.map((previous): Watch => {
    if (previous.id === existing?.id) return watch;
    return previous.question === question.id && previous.state === 'watching' ? { ...previous, state: 'stopped' } : previous;
  });
  return existing ? updated : [...updated, watch];
};

export const saveQuestionRecord = (root: string, folder: InitiativeFolder, input: QuestionDraft, now: number): Question => {
  const draft = QuestionDraftSchema.parse(input);
  const available = questionsOf(folder);
  const previous = available.find((question) => question.id === draft.id);
  if (draft.id && !previous) throw new Error('This question has changed. Reopen it and try again');
  const duplicate = available.find((question) => question.id === draft.merge && question.id !== draft.id && !question.answer);
  if (draft.merge && !duplicate) throw new Error('That duplicate question is no longer open');
  const at = new Date(now).toISOString();
  const question: Question = {
    id: previous?.id ?? randomUUID(),
    text: draft.text,
    ...(draft.waitingOn || duplicate?.waitingOn ? { waitingOn: draft.waitingOn || duplicate?.waitingOn } : {}),
    createdAt: previous?.createdAt || at,
    answer: draft.answer ? { ...draft.answer, at } : previous?.answer,
  };
  const outboxDraft = folder.outbox.find((entry) => entry.id === draft.draft && entry.state !== 'discarded');
  if (draft.draft && (!outboxDraft || !isQuestionTarget(outboxDraft.to))) throw new Error('Choose an available Slack or Jira draft');
  if (outboxDraft?.reminderFor) throw new Error('Choose the original outreach message');
  if (outboxDraft?.question && outboxDraft.question !== question.id && outboxDraft.question !== duplicate?.id) throw new Error('That draft belongs to another question');
  if (outboxDraft?.state === 'approved') throw new Error('Wait for the current send to finish before linking it');

  const keep = activeWatch(folder.watches, question.id) ?? (duplicate && activeWatch(folder.watches, duplicate.id));
  let watches: readonly Watch[] = folder.watches.map((watch): Watch => {
    if (watch.question !== question.id && (!duplicate || watch.question !== duplicate.id)) return watch;
    const updated = watchForQuestion(watch, question);
    if (watch.state !== 'watching') return updated;
    if (question.answer) return { ...updated, state: 'answered' };
    return watch.id === keep?.id ? updated : { ...updated, state: 'stopped' };
  });
  if (draft.outreach && !question.answer) watches = manualWatch(watches, question, draft.outreach, now);
  if (outboxDraft?.state === 'sent') watches = linkSentQuestionDraft(watches, question, outboxDraft, now);
  const changes = [question, ...(duplicate ? [{ ...duplicate, mergedInto: question.id }] : [])];
  const indexed = new Map(changes.map((record) => [record.id, record]));
  const updated = folder.questions.map((record) => indexed.get(record.id) ?? record);
  const newRecords = changes.filter((record) => !folder.questions.some((saved) => saved.id === record.id));
  writeQuestions(root, folder.slug, [...updated, ...newRecords]);
  if (watches.some((watch, index) => watch !== folder.watches[index])) writeWatches(root, folder.slug, watches);
  if (outboxDraft || duplicate) {
    writeOutbox(root, folder.slug, folder.outbox.map((entry) => entry.id === outboxDraft?.id || (duplicate && entry.question === duplicate.id) ? { ...entry, question: question.id } : entry));
  }
  return question;
};

export const captureQuestionAnswers = (root: string, folder: InitiativeFolder): boolean => {
  const questions = folder.questions.map((question) => {
    if (question.answer || question.mergedInto) return question;
    const solved = folder.watches.find((watch) => watch.question === question.id && watch.state === 'answered' && watch.answer?.source);
    return solved?.answer ? { ...question, answer: solved.answer } : question;
  });
  const answered = new Set(questions.filter((question) => question.answer).map((question) => question.id));
  const watches = folder.watches.map((watch): Watch => {
    if (!watch.question) return watch;
    if (watch.state === 'watching' && answered.has(watch.question)) return { ...watch, state: 'answered' };
    if (watch.state === 'answered' && !answered.has(watch.question)) return { ...watch, state: 'watching', checkedAt: undefined, checkFailed: true };
    return watch;
  });
  const changed = questions.some((question, index) => question !== folder.questions[index]);
  const watchChanged = watches.some((watch, index) => watch !== folder.watches[index]);
  if (changed) writeQuestions(root, folder.slug, questions);
  if (watchChanged) writeWatches(root, folder.slug, watches);
  return changed || watchChanged;
};
