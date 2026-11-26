import { WATCH_CHAT, type Watch, type WatchPlace, needsNudge } from './watches.js';

export const WATCHES_SHAPE =
  '[{"id" (a number, never reused), "what" (what it waits for, one line), "where" (where to look: {"kind": "slack", "channel", "thread", "label"}, {"kind": "jira", "issue", "label"}, {"kind": "doc", "ref" (its link), "label"} or {"kind": "pr", "url", "label"}), "waitingOn" (who it waits on, a plain name), "suggestion" (the suggestion or decision it belongs to), "since" (an ISO date), "every" (hours between looks; leave it out and it backs off: hourly the first day, every four hours, daily after three days), "lastLook", "until" (when it gives up; two weeks by default), "nudgedAt", "state" ("watching" | "answered" | "stopped" | "expired"), "news": [{"at", "from", "text", "read": false}]}]';

/** The memory line about watches.json, in every chat's brief. */
export const WATCHES_BRIEF = `watches.json: follow-ups Beluga keeps looking for by itself between check-ins, ${WATCHES_SHAPE}. Beluga adds one when the user sends a draft, sets "lastLook" after each look, and says when one is due. Add one yourself when an approved suggestion waits on someone, or when the user asks you to keep an eye on an answer: "state": "watching", "news": [] and "since" now. Never change "lastLook"; set "state": "stopped" when the user says to stop one.`;

/** What the check-in is told about follow-ups. */
export const WATCHES_CHECK_IN = 'Read watches.json too: news on a watch the follow-up runs already brought in counts as what happened, so do not report it again; a watch whose answer you find in what you read gets its news and "state": "answered".';

const placeHow = (where: WatchPlace): string => {
  if (where.kind === 'slack') return where.thread ? `the Slack thread ${where.thread} in ${where.channel}${where.label ? ` (${where.label})` : ''}: read its replies (conversations_replies, or slack_read_thread)` : `the Slack conversation ${where.channel}${where.label ? ` (${where.label})` : ''}: read its history (conversations_history)`;
  if (where.kind === 'jira') return `the Jira ticket ${where.issue}: its comments, status and assignee (jira_get_issue)`;
  if (where.kind === 'pr') return `the pull request ${where.url}: its reviews, comments and state (gh pr view --comments)`;
  return `the doc ${where.ref}${where.label ? ` (${where.label})` : ''}: read it as its doc source line says, and compare with its snapshot in sources/docs/ when there is one`;
};

const watchLine = (watch: Watch, now: number): string =>
  `- Watch ${watch.id}: ${watch.what}${watch.waitingOn ? `, waiting on ${watch.waitingOn}` : ''}${watch.suggestion ? ` (suggestion ${watch.suggestion})` : ''}. Look at ${placeHow(watch.where)}, for what came after ${watch.lastLook ?? watch.since}.${needsNudge(watch, now) ? ' Nothing came back in a week: draft a short, friendly nudge into outbox.json (to the same place), set its "nudgedAt" to now, and say so in one line.' : ''}`;

/** The prompt of a watch run: only the watches due now, and only their places. */
export const watchPrompt = (watches: readonly Watch[], now: number): string =>
  [
    'Look for answers on these follow-ups, and nothing else:',
    ...watches.map((w) => watchLine(w, now)),
    'Read only these places. When nothing new came in, change no file and answer with the one word: Nothing.',
    'When something new came in, for that watch: add to its "news" {"at" (now), "from" (who), "text" (in two lines at most: what came in, from whom, and what it changes), "read": false}, and set "state": "answered" once it answers what it waited for; add one line to timeline.md, "- <today> [follow-up]: <who>: <what came in>"; update decisions.md where it answers an open question, and the suggestion it belongs to (its "outcome" and "proof"); propose the next step as a suggestion in suggestions.json; a reply worth sending is a draft in outbox.json.',
    'Never change "lastLook" (Beluga sets it), never post or change anything outside this folder. Answer with one line per watch that has news.',
  ].join('\n');

export const watchChatNote = (chat: string): string =>
  chat === WATCH_CHAT
    ? '\n\nThis is the initiative’s Follow-ups chat: Beluga wakes it when watches in watches.json are due, naming only those. Look only where they say, stay silent ("Nothing") when nothing is new, and change nothing outside this folder.'
    : '';
