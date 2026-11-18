import { buildHonchoAppend } from '../../agent/honcho-prompt.js';
import type { HonchoTools } from '../../agent/types.js';
import type { HonchoFeed } from './feed.js';

export type HonchoRun = {
  readonly brief: string;
  readonly tools: HonchoTools;
};

/** What one of your own runs gets of Honcho (BLG-101): its picture of you, capped, and a tool to ask it. Undefined when Honcho is off. */
export const honchoForRun = async (feed: HonchoFeed | undefined): Promise<HonchoRun | undefined> => {
  const picture = await feed?.userPicture();
  if (!feed || picture === undefined) return undefined;
  return { brief: buildHonchoAppend(picture), tools: { ask: (question, level) => feed.askAboutUser(question, level) } };
};
