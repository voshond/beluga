import { readJson, writeJson } from './files.js';
import { PresenceSchema } from './schemas.js';
import type { Presence } from './views.js';

/**
 * Your status, kept in ~/.beluga/presence.json so "appear offline" survives a restart.
 * Choosing `offline` means appear offline: your Mac stays connected and keeps receiving,
 * but everyone sees you as offline. A status with `until` goes back to online by itself.
 */

export const ONLINE: Presence = { state: 'online' };
const HIDDEN: Presence = { state: 'offline' };

/** Your status as of now (one that ran out is back to online). */
export const current = (p: Presence, now = Date.now()): Presence => (p.until !== undefined && p.until <= now ? ONLINE : p);

/** What others are told. */
export const shown = (p: Presence, now = Date.now()): Presence => {
  const c = current(p, now);
  return c.state === 'offline' ? HIDDEN : c;
};

export function loadPresence(file: string): Presence {
  const parsed = PresenceSchema.safeParse(readJson(file));
  return parsed.success ? current(parsed.data) : ONLINE;
}

export function savePresence(file: string, p: Presence): Presence {
  const valid = PresenceSchema.parse(p);
  const clean: Presence = {
    state: valid.state,
    ...(valid.note?.trim() ? { note: valid.note.trim() } : {}),
    ...(valid.emoji?.trim() ? { emoji: valid.emoji.trim() } : {}),
    ...(valid.until ? { until: valid.until } : {}),
  };
  writeJson(file, clean);
  return clean;
}
