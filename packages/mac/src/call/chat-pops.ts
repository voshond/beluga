/**
 * The chat where it can't be seen (BLG-717): someone sharing their screen looks at another app,
 * and a screen in full screen or face to face covers the chat. There, what the others write pops
 * up on the right and dissolves once there was time to read it. Anywhere the chat shows, nothing
 * pops up: it's already there. Pure and browser-safe.
 */

/** A chat message as it pops up. */
export interface ChatPop {
  readonly id: string;
  /** Who wrote it (their peer id), and their name ("bob", or "bob’s agent" for an agent's answer). */
  readonly by: string;
  readonly name: string;
  readonly text: string;
  /** When it was written (ms since the epoch). */
  readonly at: number;
  /** An agent's answer (an Ask about the screen comes back this way). */
  readonly agent?: boolean;
}

/** Shown at once, newest last. */
export const POPS_KEPT = 4;
/** The longest a message pops up with (longer ones are cut, the chat has the rest). */
export const POP_CHARS = 280;

/** How long a message stays up: a few seconds, and more for longer ones, so it can be read. */
export function popMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(16_000, Math.max(6_000, 3_500 + words * 320));
}

/** Its words as they pop up: on one paragraph, cut at a word near `POP_CHARS`. */
export function popText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= POP_CHARS) return flat;
  const cut = flat.slice(0, POP_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > POP_CHARS * 0.7 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

/**
 * When each message first showed up on this Mac. Another Mac's clock can be a little off, so a
 * message's own time can't say whether it's new: what was already there when the chat went out of
 * sight never pops up, and what comes after counts from when it came.
 */
export class PopClock {
  private readonly seen = new Map<string, number>();

  constructor(already: readonly ChatPop[]) {
    for (const m of already) this.seen.set(m.id, -Infinity);
  }

  /** The messages with `at` as when each came here. */
  stamp(messages: readonly ChatPop[], now: number): ChatPop[] {
    return messages.map((m) => {
      let at = this.seen.get(m.id);
      if (at === undefined) {
        at = now;
        this.seen.set(m.id, at);
      }
      return { ...m, at };
    });
  }
}

/** What pops up now (`messages` stamped by a `PopClock`): still within its time, the newest `POPS_KEPT`. */
export function popsNow(messages: readonly ChatPop[], now: number): ChatPop[] {
  return messages
    .filter((m) => now - m.at < popMs(m.text))
    .sort((a, b) => a.at - b.at)
    .slice(-POPS_KEPT)
    .map((m) => ({ ...m, text: popText(m.text) }));
}
