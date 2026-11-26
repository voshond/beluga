import { z } from 'zod';

/** An audience's id in initiative.json, from its name (`Leadership` → `leadership`). */
export const AUDIENCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Short for execs (a few lines), detailed for the team (sections). */
export const UPDATE_TONES = ['short', 'detailed'] as const;
export type UpdateTone = (typeof UPDATE_TONES)[number];

export const UPDATE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** When an update to it is due: weekdays (0 is Sunday) at a time; no days means on request only. */
export const CadenceSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  at: z.string().regex(UPDATE_TIME).default('09:00'),
});
export type Cadence = z.infer<typeof CadenceSchema>;

const label = z.string().trim().max(200).optional();

/** Where an audience's update goes: a Slack channel or thread, one section of a Confluence page, or a prep sheet for a followed meeting (never sent). */
export const AudienceTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slack'), channel: z.string().trim().min(1).max(200), thread: z.string().trim().max(40).optional(), label }),
  z.object({ kind: z.literal('confluence'), page: z.string().regex(/^\d{1,20}$/), section: z.string().trim().min(1).max(200), label }),
  z.object({ kind: z.literal('prep'), meeting: z.string().trim().min(1).max(500), label }),
]);
export type AudienceTarget = z.infer<typeof AudienceTargetSchema>;

export const AudienceSchema = z.object({
  id: z.string().regex(AUDIENCE_ID),
  name: z.string().trim().min(1).max(120),
  /** Directory slugs (people/<slug>.json). */
  people: z.array(z.string().regex(AUDIENCE_ID)).max(100).default([]),
  tone: z.enum(UPDATE_TONES).default('detailed'),
  cadence: CadenceSchema.default({ days: [], at: '09:00' }),
  target: AudienceTargetSchema,
});
export type Audience = z.infer<typeof AudienceSchema>;

/** What the page sends to add or edit one: no id makes a new one. */
export const AudienceDraftSchema = AudienceSchema.extend({ id: z.string().regex(AUDIENCE_ID).optional() });
export type AudienceDraft = z.input<typeof AudienceDraftSchema>;

export const AudiencesSchema = z.array(AudienceSchema).max(20);
