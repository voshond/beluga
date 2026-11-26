import { z } from 'zod';
import { WatchDraftSchema } from '../core/initiatives/watches.js';
import { CheckInScheduleSchema, GoalRefineSchema, INITIATIVE_CHAT_ID, INITIATIVE_SLUG, InitiativeDraftSchema, InitiativePatchSchema } from '../core/initiatives/model.js';

const slug = z.string().regex(INITIATIVE_SLUG);
const chat = z.string().regex(INITIATIVE_CHAT_ID);

export const INITIATIVES_API = {
  'initiatives.create': { args: z.tuple([InitiativeDraftSchema]) },
  'initiatives.update': { args: z.tuple([slug, InitiativePatchSchema]) },
  'initiatives.archive': { args: z.tuple([slug]) },
  'initiatives.setRepo': { args: z.tuple([slug, z.string().min(1).max(120), z.boolean()]) },
  'initiatives.setCheckIn': { args: z.tuple([slug, z.boolean()]) },
  'initiatives.setCheckInTime': { args: z.tuple([slug, CheckInScheduleSchema]) },
  'initiatives.checkInNow': { args: z.tuple([slug]) },
  'initiatives.refreshTickets': { args: z.tuple([slug]) },
  'initiatives.refreshTasks': { args: z.tuple([slug]) },
  'initiatives.setTaskDone': { args: z.tuple([slug, z.string().min(1).max(80), z.boolean()]) },
  'initiatives.refineGoal': { args: z.tuple([GoalRefineSchema]) },
  'initiatives.chatNew': { args: z.tuple([slug]) },
  'initiatives.chatOpen': { args: z.tuple([slug, chat]) },
  'initiatives.chatDelete': { args: z.tuple([slug, chat]) },
  'initiatives.resolveSuggestion': { args: z.tuple([slug, z.number().int().min(1), z.enum(['approve', 'dismiss']), z.string().trim().min(1).max(2000).optional()]) },
  'initiatives.clarifySuggestion': { args: z.tuple([slug, z.number().int().min(1)]) },
  'initiatives.sendDraft': { args: z.tuple([slug, z.number().int().min(1), z.string().trim().min(1).max(5000)]) },
  'initiatives.discardDraft': { args: z.tuple([slug, z.number().int().min(1)]) },
  'initiatives.readFile': { args: z.tuple([slug, z.string().min(1).max(400)]) },
  'initiatives.readArtifact': { args: z.tuple([slug, z.number().int().min(1)]) },
  'initiatives.addWatch': { args: z.tuple([slug, WatchDraftSchema]) },
  'initiatives.stopWatch': { args: z.tuple([slug, z.number().int().min(1)]) },
  'initiatives.lookNow': { args: z.tuple([slug, z.number().int().min(1)]) },
  'initiatives.readNews': { args: z.tuple([slug, z.number().int().min(1).optional()]) },
} as const;
