import { type AssistantChat, assistantChatOf } from '../../../../src/shared/assistant.js';
import type { ChatSchedule, OnceTrigger, SentinelDraft, Trigger } from '../../../../src/core/sentinel/model.js';

/**
 * The /schedule sheet's model (BLG-400): a sentinel with one trigger and one chat step that wakes
 * the chat it was made in. Also how a chat's schedules read (spent, the sidebar's clock). Pure: the
 * sheet, the Info panel and tests/mac-schedule-sheet.test.ts read it.
 */

const NAME_MAX = 48;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The sentinel the sheet makes: its trigger, and one chat step to this chat (`ref`), in its project when it has one. */
export function scheduleDraft({ trigger, prompt, ref, projectId }: { trigger: Trigger; prompt: string; ref: string; projectId?: string }): SentinelDraft {
  return {
    name: scheduleName(prompt),
    icon: 'calendar',
    ...(projectId ? { projectId } : {}),
    trigger,
    steps: [{ kind: 'chat', name: 'Wake this chat', to: ref, text: prompt.trim() }],
  };
}

/** 'In N hours': a once trigger at now + N hours, up to the next minute, and a minute ahead at least. */
export function onceIn(hours: number, now: number): OnceTrigger {
  const at = Math.ceil(Math.max(now + hours * HOUR, now + MINUTE) / MINUTE) * MINUTE;
  return { kind: 'once', at: isoLocal(at), missed: 'catch-up' };
}

/** The next whole hour on the Mac's clock: where a new Once moment starts. */
export function nextWholeHour(now: number): number {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  return d.getTime() + HOUR;
}

/** A Once moment still ahead of now (a past one is refused at create). */
export const onceAhead = (t: OnceTrigger, now: number): boolean => new Date(t.at).getTime() > now;

/** A moment as an ISO date and time with the Mac's offset ("2026-11-12T19:30:00+01:00"), as a once trigger keeps it. */
export function isoLocal(ts: number): string {
  const d = new Date(ts);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The schedule's name: its prompt's first line, cut short. */
export function scheduleName(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.trim();
  if (!line) return 'Chat schedule';
  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line;
}

/** The prompt after '/schedule' ('' for none), or undefined when the words aren't that command. */
export function scheduleCommand(text: string): string | undefined {
  const m = /^\/schedule(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? (m[1] ?? '').trim() : undefined;
}

/**
 * A chat a schedule can wake: one of your worktree or project chats, or a Your Mac chat (not a shared
 * one). Not a Your Mac chat Beluga made for itself (`auto`: a sentinel run's), from `macChats`.
 */
export function canSchedule(channel: string, shared: boolean, macChats: ReadonlyArray<Pick<AssistantChat, 'id' | 'auto'>> = []): boolean {
  if (shared) return false;
  if (channel.startsWith('ws:')) return true;
  const chat = assistantChatOf(channel);
  return chat !== undefined && !macChats.some((c) => c.id === chat && c.auto);
}

/** A one-time schedule that already ran: on, with no next time and no run going. It reads as off. */
export const scheduleSpent = (row: ChatSchedule): boolean => row.trigger.kind === 'once' && row.nextAt === undefined && !row.paused && !row.running;

/** A chat's schedules as its sidebar row's clock says them: how many, and whether all are off (or spent). None: no clock. */
export function scheduleMark(rows: readonly ChatSchedule[]): { readonly count: number; readonly paused: boolean } | undefined {
  return rows.length ? { count: rows.length, paused: rows.every((r) => r.paused || scheduleSpent(r)) } : undefined;
}

const pad = (n: number): string => String(n).padStart(2, '0');
