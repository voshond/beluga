import { WATCH_CHAT, type Watch, type WatchPlace, needsNudge } from './watches.js';

export const WATCHES_SHAPE =
  '[{"id" (a number, never reused), "what" (what it waits for, one line), "where" (where to look: {"kind": "slack", "channel", "thread", "label"}, {"kind": "jira", "issue", "label"}, {"kind": "doc", "ref" (its link), "label"} or {"kind": "pr", "url", "label"}), "waitingOn" (who it waits on, a plain name), "suggestion" (the suggestion or decision it belongs to), "since" (an ISO date), "every" (hours between looks; leave it out and it backs off: hourly the first day, every four hours, daily after three days), "lastLook", "until" (when it gives up; two weeks by default), "nudgedAt", "state" ("watching" | "answered" | "stopped" | "expired"), "news": [{"at", "from", "text", "read": false}]}]';

/** The memory line about watches.json, in every chat's brief. */
export const WATCHES_BRIEF = `watches.json: follow-ups Beluga keeps looking for by itself between check-ins, ${WATCHES_SHAPE}. Beluga adds one when the user sends a draft, sets "lastLook" after each look, and says when one is due. A watch with a "question" id belongs to questions.json, which Beluga manages. Reuse that watch. Add one yourself when an approved suggestion waits on someone, or when the user asks you to keep an eye on an answer: "state": "watching", "news": [] and "since" now. Never change "lastLook"; set "state": "stopped" when the user says to stop one.`;

/** What the check-in is told about follow-ups. */
export const WATCHES_CHECK_IN = 'Read watches.json too: news on a watch the follow-up runs already brought in counts as what happened, so do not report it again; a watch whose answer you find in what you read gets its news and "state": "answered". A watch with a "question" id also needs "answer": {"text": the complete answer, "source": the exact reply URL, "at": ISO datetime}. Keep it watching if the reply is partial or no reply URL is available.';

const placeHow = (where: WatchPlace): string => {
  if (where.kind === 'slack') return where.thread ? `the Slack thread ${where.thread} in ${where.channel}${where.label ? ` (${where.label})` : ''}: read its replies (conversations_replies, or slack_read_thread)` : `the Slack conversation ${where.channel}${where.label ? ` (${where.label})` : ''}: read its history (conversations_history)`;
  if (where.kind === 'jira') return `the Jira ticket ${where.issue}: its comments, status and assignee (jira_get_issue)`;
  if (where.kind === 'pr') return `the pull request ${where.url}: its reviews, comments and state (gh pr view --comments)`;
  return `the doc ${where.ref}${where.label ? ` (${where.label})` : ''}: read it as its doc source line says, and compare with its snapshot in sources/docs/ when there is one`;
};

const watchLine = (watch: Watch, now: number): string => {
  const cutoff = watch.question ? watch.checkedAt ?? watch.since : watch.lastLook ?? watch.since;
  const nudge = !watch.question && needsNudge(watch, now)
    ? ' If still no reply, draft a short, friendly nudge into outbox.json to the same place and set "nudgedAt" to now.' : '';
  return `- Watch ${watch.id}: ${watch.what}${watch.waitingOn ? `, waiting on ${watch.waitingOn}` : ''}${watch.suggestion ? ` (suggestion ${watch.suggestion})` : ''}${watch.question ? ` (question ${watch.question})` : ''}. Look at ${placeHow(watch.where)}, for what came after ${cutoff}.${nudge}`;
};

/** The prompt of a watch run: only the watches due now, and only their places. */
export const watchPrompt = (watches: readonly Watch[], now: number): string =>
  [
    'Look for answers on these follow-ups, and nothing else:',
    ...watches.map((w) => watchLine(w, now)),
    'Read only these places. For a watch with a question id, record "checkedAt" as the ISO datetime when you started the source read, but only after successfully reading it. Ignore your own outgoing messages and unrelated replies. If the source could not be read, leave checkedAt alone and report the failure. When a legacy watch has no new reply or nudge due, change no file and answer with the one word: Nothing. For an editable question with nothing to report, answer the same after recording the check.',
    'When something new came in, for that watch: add to its "news" {"at" (now), "from" (who), "text" (in two lines at most: what came in, from whom, and what it changes), "read": false}, and set "state": "answered" once it answers what it waited for; add one line to timeline.md, "- <today> [follow-up]: <who>: <what came in>"; update decisions.md where it answers a legacy question. For a watch with a question id, a partial reply is only news. For a complete reply, write its "answer": {"text": the complete answer, "at": ISO datetime, "source": the exact reply URL} and set "state": "answered". Keep it watching if you do not have that URL; Beluga updates the question and drafts any late reminder, so do not edit questions.json or draft a reminder for it. Update the suggestion it belongs to (its "outcome" and "proof"); propose the next step as a suggestion in suggestions.json; a reply worth sending is a draft in outbox.json.',
    'Never change "lastLook" (Beluga sets it), never post or change anything outside this folder. Answer with one line per watch that has news.',
  ].join('\n');

export const watchChatNote = (chat: string): string =>
  chat === WATCH_CHAT
    ? '\n\nThis is the initiative’s Follow-ups chat: Beluga wakes it when watches in watches.json are due, naming only those. Look only where they say, stay silent ("Nothing") when nothing is new, and change nothing outside this folder.'
    : '';
