import { z } from 'zod';
import { EmojiSchema, type ReactionEvent, applyReaction } from '../../../shared/reactions.js';
import type { ReadMessage } from './engine.js';

/**
 * Reactions in a group (BLG-702). One rides in the group's log as an encrypted message of its
 * author's, `{ text, react: { to, e, on } }`, so it syncs, is kept and is checked like any message,
 * and nobody outside the group sees who reacted with what. Macs that know reactions read it as a
 * change to message `to`; older ones show its `text` ("Reacted 👍 to “Morning!…”").
 * An author's own entries always come later in the log than their earlier ones, so its position
 * (`lamport`) orders their changes to one emoji the same on every copy.
 */

export const GroupReactSchema = z.object({ to: z.string().regex(/^[0-9a-f]{64}$/), e: EmojiSchema, on: z.boolean() });
export type GroupReact = z.infer<typeof GroupReactSchema>;

/** The reaction a message's sealed JSON carries, if it's a well-formed one. */
export function parseGroupReact(raw: unknown): GroupReact | undefined {
  if (!raw || typeof raw !== 'object' || !('react' in raw)) return undefined;
  const parsed = GroupReactSchema.safeParse((raw as { react: unknown }).react);
  return parsed.success ? parsed.data : undefined;
}

const QUOTE = 60;

/** What an older Mac shows for a reaction: "Reacted 👍 to “Morning! Staging is green…”". */
export function reactNote(emoji: string, on: boolean, target: string): string {
  const words = target.replace(/\s+/g, ' ').trim();
  const quote = words.length > QUOTE ? `${words.slice(0, QUOTE - 1).trimEnd()}…` : words;
  const verb = on ? `Reacted ${emoji} to` : `Took back ${emoji} from`;
  return quote ? `${verb} “${quote}”` : on ? `Reacted ${emoji}` : `Took back ${emoji}`;
}

/** A reaction entry as one person's change to message `to`. */
export const groupEvent = (m: ReadMessage & { readonly react: GroupReact }): ReactionEvent => ({ id: m.react.to, emoji: m.react.e, by: m.entry.author, on: m.react.on, at: m.entry.lamport });

/**
 * A group's log read: its messages (reactions taken out) and each message's reaction changes.
 * A reaction to something that isn't one of the group's messages counts for nothing.
 */
export function splitReactions(read: readonly ReadMessage[]): { messages: ReadMessage[]; reactions: Map<string, readonly ReactionEvent[]> } {
  const messages = read.filter((m) => !m.react);
  const ids = new Set(messages.map((m) => m.entry.id));
  const reactions = new Map<string, readonly ReactionEvent[]>();
  for (const m of read) {
    if (!m.react || !ids.has(m.react.to)) continue;
    const e = groupEvent(m as ReadMessage & { react: GroupReact });
    const next = applyReaction(reactions.get(e.id) ?? [], e);
    if (next) reactions.set(e.id, next);
  }
  return { messages, reactions };
}
