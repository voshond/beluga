import { buildHonchoAppend } from '../../agent/honcho-prompt.js';
import type { HonchoTools } from '../../agent/types.js';
import type { HonchoFeed } from './feed.js';

export type HonchoRun = {
  readonly brief: string;
  readonly tools: HonchoTools;
};

/** What a run is about (BLG-122): its project's name and what was asked, for Honcho to pick the picture around. */
export type HonchoFocus = {
  readonly project?: string;
  readonly request?: string;
};

const QUERY_MAX = 400;

/** The search query for a run's picture: the project, then the start of the request. Empty: the picture with no query. */
export const pictureQuery = (focus: HonchoFocus = {}): string => {
  const request = (focus.request ?? '').replace(/\s+/g, ' ').trim();
  const project = focus.project?.trim();
  return (project ? (request ? `${project}: ${request}` : project) : request).slice(0, QUERY_MAX);
};

/** What one of your own runs gets of Honcho (BLG-101): its picture of you, picked for the run and capped, and a tool to ask it. Undefined when Honcho is off. */
export const honchoForRun = async (feed: HonchoFeed | undefined, focus?: HonchoFocus): Promise<HonchoRun | undefined> => {
  const picture = await feed?.userPicture(undefined, pictureQuery(focus));
  if (!feed || picture === undefined) return undefined;
  return { brief: buildHonchoAppend(picture), tools: { ask: (question, level) => feed.askAboutUser(question, level) } };
};
