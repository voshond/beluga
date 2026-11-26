import { z } from 'zod';
import { QuestionSourceSchema } from './questions.js';
import type { OutboxTarget } from './model.js';
import { slackMessageTime, watchPlaceOf } from './watches.js';

const ReceiptSchema = z.object({
  ok: z.boolean().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  errors: z.array(z.string()).optional(),
  errorMessages: z.array(z.string()).optional(),
  channel: z.string().optional(),
  ts: z.string().optional(),
  permalink: z.string().optional(),
  url: z.string().optional(),
  self: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  message: z.object({ ts: z.string().optional() }).optional().catch(undefined),
  result: z.string().optional(),
  data: z.lazy((): z.ZodType<Receipt> => ReceiptSchema).optional(),
});
type Receipt = {
  ok?: boolean;
  success?: boolean;
  error?: string;
  errors?: string[];
  errorMessages?: string[];
  channel?: string;
  ts?: string;
  permalink?: string;
  url?: string;
  self?: string;
  id?: string | number;
  message?: { ts?: string };
  result?: string;
  data?: Receipt;
};

const receiptOf = (output: string): Receipt | undefined => {
  const json = output.trim().replace(/^\x60{3}(?:json)?\s+|\s*\x60{3}$/gi, '');
  try {
    const receipt = ReceiptSchema.safeParse(JSON.parse(json));
    return receipt.success ? receipt.data : undefined;
  } catch {
    return undefined;
  }
};

export type Delivery = { error?: string; channel?: string; thread?: string; source?: string };

const slackLinkOnly = /^(?:message (?:sent|posted)[: ]+)?(?:\[[^\]]+\]\()?((?:https:\/\/)(?:[^/.]+\.)*slack\.com\/archives\/[CDG][A-Z0-9]+\/p\d{16}(?:\?[^\s)]+)?)(?:\))?\.?$/i;

export const deliveryOf = (to: OutboxTarget, output: string): Delivery => {
  const top = receiptOf(output);
  const receipt = top?.data ?? (top?.result ? receiptOf(top.result) : undefined) ?? top;
  if ([top, receipt].some((result) => result && (result.ok === false || result.success === false || result.error || result.errors?.length || result.errorMessages?.length))) {
    return { error: 'The destination rejected the send. Check the chat for details.' };
  }
  const url = QuestionSourceSchema.safeParse(receipt?.permalink ?? receipt?.url ?? receipt?.self ?? (to.kind === 'slack' ? slackLinkOnly.exec(output.trim())?.[1] : undefined));
  if (to.kind === 'jira' && !(receipt?.id || receipt?.ok || receipt?.success || top?.success || url.success)) {
    return { error: 'Jira did not confirm delivery. Check the issue before retrying.' };
  }
  if (to.kind === 'jira' && receipt?.self && /^\d+$/.test(String(receipt.id))) {
    const self = QuestionSourceSchema.safeParse(receipt.self);
    if (self.success) return { source: `${new URL(self.data).origin}/browse/${to.issue}?focusedCommentId=${receipt.id}` };
  }
  if (to.kind !== 'slack') {
    return url.success && !url.data.includes('/rest/api/') ? { source: url.data } : {};
  }
  const place = url.success ? watchPlaceOf(url.data) : undefined;
  const resultChannel = receipt?.channel ?? (place?.kind === 'slack' ? place.channel : undefined);
  const dmViaUser = /^[UW][A-Z0-9]+$/.test(to.channel) && resultChannel && /^D[A-Z0-9]+$/.test(resultChannel);
  if (resultChannel && resultChannel !== to.channel && !dmViaUser) return { error: 'Slack returned a different destination. Check the chat before retrying.' };
  const channel = resultChannel ?? to.channel;
  const linkedThread = place?.kind === 'slack' && place.channel === channel ? place.thread : undefined;
  const receiptTs = receipt?.ts ?? receipt?.message?.ts;
  const ts = receiptTs && slackMessageTime(receiptTs) !== undefined ? receiptTs : linkedThread;
  if (!(top?.ok || receipt?.ok || top?.success || receipt?.success || ts)) {
    return { error: 'Slack did not confirm delivery. Check the conversation before retrying.' };
  }
  const domain = linkedThread && url.success ? new URL(url.data).origin : 'https://app.slack.com';
  const source = url.success && linkedThread ? url.data : ts ? `${domain}/archives/${channel}/p${ts.replace('.', '')}` : undefined;
  return { channel, thread: to.thread ?? ts, source };
};
