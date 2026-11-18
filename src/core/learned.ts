import type { ChatTools } from '../agent/types.js';
import type { LearnedDraft } from '../shared/learned.js';

/** Puts a marker on the run's card (BLG-102, shared/learned.ts). */
export type Learn = (draft: LearnedDraft) => void;

/** The run's chat tools, with each search of past chats marked on its card (the words searched). */
export const withRecall = (chats: ChatTools | undefined, learn: Learn | undefined): ChatTools | undefined => {
  if (!chats || !learn) return chats;
  return {
    ...chats,
    search: (query, opts) => {
      const found = chats.search(query, opts);
      learn({ kind: 'recall', query: query.replace(/\s+/g, ' ').trim().slice(0, 200) });
      return found;
    },
  };
};
