import { z } from 'zod';
import type { Watch } from './watches.js';

export const QuestionIdSchema = z.string().regex(/^(?:[a-f0-9-]{36}|legacy-[a-f0-9]{32})$/);
const questionText = z.string().trim().min(1).max(4000);
const personName = z.string().trim().max(120);
const timestamp = z.string().datetime({ offset: true });
export const QuestionSourceSchema = z.string().trim().max(1000).url().regex(/^https?:\/\//i);
export const QuestionAnswerSchema = z.object({
  text: questionText,
  source: QuestionSourceSchema.optional(),
  at: timestamp,
});

export const QuestionSchema = z.object({
  id: QuestionIdSchema,
  text: questionText,
  waitingOn: personName.optional(),
  createdAt: z.string().max(40),
  answer: QuestionAnswerSchema.optional(),
  mergedInto: QuestionIdSchema.optional(),
});

export const QuestionsSchema = z.array(QuestionSchema);
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionDraftSchema = z.object({
  id: QuestionIdSchema.optional(),
  text: questionText,
  waitingOn: personName.optional(),
  merge: QuestionIdSchema.optional(),
  draft: z.number().int().positive().optional(),
  outreach: z.object({
    ref: z.string().trim().min(1).max(500),
    since: timestamp.optional(),
  }).optional(),
  answer: QuestionAnswerSchema.omit({ at: true }).optional(),
}).refine((draft) => !(draft.draft && draft.outreach), 'Choose a draft or a message link');

export type QuestionDraft = z.input<typeof QuestionDraftSchema>;

export const questionWatch = (id: string, watches: readonly Watch[]): Watch | undefined =>
  watches.find((watch) => watch.question === id && watch.state === 'watching')
  ?? [...watches].reverse().find((watch) => watch.question === id);

export const questionState = (question: Question, watch?: Watch) => {
  if (question.answer) return 'answered';
  if (watch?.state === 'watching') return 'waiting';
  if (watch) return 'inactive';
  return 'outreach';
};
