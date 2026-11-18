import type { MemoryChange } from './memory.js';

/**
 * What a run did with Beluga's learning features (BLG-102), kept on its card so the chat shows it
 * under the answer and it survives a reload: a memory write (with Undo), a skill it proposed, a
 * search of past chats. Only the owner's own card has them; they never go to the room.
 * Browser-safe: types and words only.
 */

export type MemoryMark = {
  readonly id: string;
  readonly kind: 'memory';
  readonly ts: number;
  readonly change: MemoryChange;
  /** The project's name, for a project's memory. */
  readonly project?: string;
  /** When Undo put it back as it was. */
  readonly undone?: number;
};

export type SkillMark = {
  readonly id: string;
  readonly kind: 'skill';
  readonly ts: number;
  /** The proposal's id: its Keep / Discard card in Needs You while it waits. */
  readonly proposal: string;
  readonly name: string;
  /** A change to a skill the user has, not a new one. */
  readonly update: boolean;
};

export type RecallMark = {
  readonly id: string;
  readonly kind: 'recall';
  readonly ts: number;
  readonly query: string;
};

export type LearnedMark = MemoryMark | SkillMark | RecallMark;

export type LearnedDraft = LearnedMark extends infer M ? (M extends LearnedMark ? Omit<M, 'id' | 'ts'> : never) : never;

/** At most this many on one card: the newest win. */
export const MAX_LEARNED = 40;

const OP_WORDS = { add: 'Remembered', replace: 'Changed a memory', remove: 'Forgot' } as const;

/** A marker's words: "Remembered", "Proposed the skill deploy-nas", "Searched past chats for “nas”". */
export const learnedTitle = (mark: LearnedMark): string => {
  if (mark.kind === 'memory') return OP_WORDS[mark.change.op];
  if (mark.kind === 'skill') return mark.update ? `Proposed a change to the skill ${mark.name}` : `Proposed the skill ${mark.name}`;
  return `Searched past chats for “${mark.query}”`;
};

/** Whose memory a memory mark is about: "About you", or the project's name. */
export const learnedScope = (mark: MemoryMark): string => (mark.change.scope.kind === 'user' ? 'About you' : (mark.project ?? 'This project'));
