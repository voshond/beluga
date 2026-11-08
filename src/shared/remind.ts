import { hhmm } from './clock.js';

// Remind Me Later on one conversation (BLG-748), as data: it stays quiet until then, then Beluga
// reminds you once. The core keeps the time and reminds; the screens offer it and show it.

export type RemindChoice = 'hour' | 'hours' | 'tomorrow' | 'week';

export const REMIND_CHOICES: ReadonlyArray<{ readonly value: RemindChoice; readonly label: string }> = [
  { value: 'hour', label: 'In 1 Hour' },
  { value: 'hours', label: 'In 3 Hours' },
  { value: 'tomorrow', label: 'Tomorrow Morning' },
  { value: 'week', label: 'Next Week' },
];

/** The hour a day starts (8 in the morning, local time), as Do Not Disturb's "tomorrow" (quiet.ts). */
const MORNING = 8;
const HOUR = 3_600_000;
/** setTimeout's longest wait: a later reminder is waited for in steps. */
export const LONGEST_WAIT_MS = 2 ** 31 - 1;

/** When to remind you, for a choice made at `now`: tomorrow and next week (Monday) in the morning. */
export function remindTime(choice: RemindChoice, now = Date.now()): number {
  if (choice === 'hour') return now + HOUR;
  if (choice === 'hours') return now + 3 * HOUR;
  const d = new Date(now);
  // Next Monday (a week on, from a Monday).
  d.setDate(d.getDate() + (choice === 'tomorrow' ? 1 : ((8 - d.getDay()) % 7 || 7)));
  d.setHours(MORNING, 0, 0, 0);
  return d.getTime();
}

/** Put off until later right now: quiet until it reminds you. */
export const remindPending = (ws: { readonly remindAt?: number }, now = Date.now()): boolean => ws.remindAt !== undefined && ws.remindAt > now;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "Reminds you at 14:30", "… tomorrow at 08:00", "… Mon at 08:00"; '' when nothing is put off. */
export function remindLabel(ws: { readonly remindAt?: number }, now = Date.now()): string {
  if (!remindPending(ws, now)) return '';
  const at = ws.remindAt!;
  const end = new Date(at);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = end.toDateString() === new Date(now).toDateString() ? '' : end.toDateString() === tomorrow.toDateString() ? 'tomorrow ' : `${WEEKDAYS[end.getDay()]} `;
  return `Reminds you ${day}at ${hhmm(at)}`;
}
