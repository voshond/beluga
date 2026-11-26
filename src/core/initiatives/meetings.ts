import type { MeetingRef } from "./model.js";

/** Where a held meeting's summary goes: sources/meetings/<day>-<title slug>.md. */
export const meetingNotesFile = (day: string, title: string): string => {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "meeting";
  return `sources/meetings/${day}-${slug}.md`;
};

/** The timeline line for a meeting held without notes anywhere. */
export const noNotesLine = (day: string, title: string): string =>
  `${day} [meeting]: ${title} held, no notes found (looked in the event, Drive and call notes)`;

const NO_MEETINGS_HOW =
  'When it follows no meetings, look at the calendar (get_agenda, a week back and two weeks ahead) for recurring meetings whose title names it, one of its epics or the people in people.md, and propose them in one suggestion of kind "calendar" ("Follow these meetings: …", each with its title, when it recurs and its link), never a second while one is open.';

export const MEETINGS_HOW = [
  "For each meeting it follows, one that is coming gets prep notes (what to raise, what is open, who to ask) in sources/meetings/.",
  'Each one held since the last check-in (status.json’s "at"; a week back when there is none) gets read; only the meetings it follows, never the rest of the calendar.',
  'Find its notes or transcript in this order: the event’s attachments and description (the calendar MCP’s get_event), then Drive (drive_search with the meeting’s title and date, for its "Notes by Gemini" doc and its Meet transcript, then drive_read_file), then Beluga call notes (call_notes_search with words from its title or agenda, or call_notes_list for the calls that day, then call_notes_read a page at a time).',
  "A doc or transcript may be too big for one answer: when a tool says its result was saved to a file, Read that file with offset and limit, a few hundred lines at a time, until you reach its end, keeping notes as you go; never work from the first part alone.",
  `Write what was said to ${meetingNotesFile("YYYY-MM-DD", "title")} (skip a meeting that already has one): who was there, a short summary, the decisions, the action items and the asks, and where the notes came from (their links). A transcript may hold things said in confidence: keep only your summary in this folder, never the raw transcript or long quotes from it.`,
  'Each decision made in it goes into the decision log as a new suggestion that is already decided: kind "decision", "text" the question it settled, "answer" what was decided, "state": "approved", "resolvedAt" the meeting’s start, "outcome" "Decided in <title> on <date>", and "sources" the meeting’s notes and event. It was settled in the room and is not the user’s call any more, so this is the one time you write a state yourself. Record it in decisions.md under "## Decided" too. When it settles a question that is still an open decision in suggestions.json, leave that one’s state alone and add to its "why" that the meeting settled it and how, so the user answers it with one click.',
  'Each action item for the user becomes a suggestion of kind "task" ("Create a task: …", with the meeting in its "sources" and the due date if one was said), unless tasks.json already has it; never create a task on your own.',
  'Each thing someone else agreed to do is waiting on them: name them in plain words ("Waiting on Natalia: the final tax table, by Friday (Go/no-go, 2026-11-26)") under "## Waiting on" in decisions.md and next to them in people.md, with a timeline line; drop it once it is done.',
  `Add a timeline line for each meeting held ("2026-11-26 [meeting]: Go/no-go held: 2 decisions, 3 action items"). When you find no notes, say so instead ("${noNotesLine("2026-11-26", "Go/no-go")}") and carry on with the rest of the check-in.`,
  NO_MEETINGS_HOW,
].join(" ");

/** The brief's meeting section: where their notes are, or what to do when it follows none. */
export const meetingsHint = (meetings: readonly MeetingRef[]): string =>
  meetings.length
    ? 'Their notes: the event’s attachments (get_event), Drive (drive_search: "Notes by Gemini", Meet transcripts) and Beluga call notes (call_notes_search); a summary of each held one goes in sources/meetings/, never the raw transcript.'
    : `No meetings followed yet. ${NO_MEETINGS_HOW}`;
