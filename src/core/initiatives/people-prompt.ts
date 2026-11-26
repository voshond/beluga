import type { InitiativeView } from './model.js';
import { type Person, membersOf } from './people.js';

const PROPOSAL_SHAPE =
  '{"id" (a number, never reused), "text" ("Add N people from people.md to the directory"), "why", "kind": "other", "state": "open", "createdAt", "people": [{"name", "role" (their role in this initiative), "cares" (what they care about here), "slack" (their Slack handle or DM id, when people.md has it), "jira" (their Jira name or handle), "notes" (the rest people.md says about them), "person" (the slug of the directory entry that is the same person, when there is one)}]}';

/** The one-time pass: people.md's stakeholders proposed as one suggestion; approving it writes the directory. */
export const PEOPLE_PASS = [
  'Propose this initiative’s people for the directory, and nothing else.',
  `Read people.md and write one suggestion to suggestions.json that lists every real person in it: ${PROPOSAL_SHAPE}.`,
  'Leave out teams and groups without a person ("Marketing"), and anyone already on this initiative. Never write the directory (the people/ folder next to this one) or initiative.json yourself: the user approves the suggestion, and Beluga writes them.',
  'Answer with one line: how many people you proposed.',
].join(' ');

/** What the check-in does about people, on top of the rest. */
export const PEOPLE_CHECK_IN = [
  'People: on every open suggestion that waits on someone’s answer or work, set "waitingOn" to that person (their directory slug, or their name); on one someone is waiting on the user for, set "askedBy" to them.',
  'Use track_question for an external question and set waitingOn to the people who can answer. Use the directory names. An older decisions.md entry can still use "(waiting on: <their name>)".',
  `When initiative.json has no people yet and suggestions.json has no suggestion with "people", also do this once: ${PEOPLE_PASS.replace(/ Answer with one line: .*$/, '')}`,
].join(' ');

const personLine = (person: Person): string =>
  [person.name, `slug ${person.slug}`, person.slack ? `Slack ${person.slack}` : '', person.jira ? `Jira ${person.jira}` : '', person.cares ? `cares about: ${person.cares}` : ''].filter(Boolean).join(' · ');

/** The brief's part on people: who is on this initiative with their role, the directory, and how to name them. */
export const peopleBrief = (item: Pick<InitiativeView, 'people'>, people: readonly Person[]): string => {
  const members = membersOf(item, people);
  const on = members.length ? members.map((m) => `- ${m.name}${m.role ? `: ${m.role}` : ''} (slug ${m.slug})`).join('\n') : '- nobody yet';
  const others = people.filter((p) => !members.some((m) => m.slug === p.slug));
  return `People on this initiative, with their role here (the directory at the repo's root, people/<slug>.json, holds each person once for every initiative; the user edits it on the page):
${on}
${others.length ? `Others in the directory:\n${others.map((p) => `- ${personLine(p)}`).join('\n')}` : 'Nobody else is in the directory yet.'}
${members.length ? `Directory entries of the people here:\n${members.flatMap((m) => (m.person ? [`- ${personLine(m.person)}`] : [])).join('\n') || '- none yet'}` : ''}
Name people by their slug in a suggestion's "waitingOn" (what waits on their answer or work) and "askedBy" (who waits on the user for it); the page derives what is open with each person from those and from an editable question that is watching for their reply. Never write the people/ folder or initiative.json's people: propose a change as a suggestion with "people" ([{"name", "role", "cares", "slack", "jira", "notes", "person"}]), which the user approves.`;
};
