import { DAY_NAMES } from '../sentinel/model.js';
import type { Audience, AudienceTarget } from './audience.js';
import { type InitiativeView, MESSAGE_MAX, PAGE_MAX } from './model.js';
import type { Person } from './people.js';
import { UPDATES_DIR, decisionsSince, deltaLines, isUpdateDue, lastUpdateOf, nextDueOf, openWithWhom, pendingUpdateOf, ticketDelta, timelineSince } from './updates.js';

const TONE_HOW: Readonly<Record<Audience['tone'], string>> = {
  short: 'short, for execs: at most five lines: where it stands in one line, then only what changed that matters, the decisions, and what you need from them; no ticket lists',
  detailed: 'detailed, for the team: sections What changed, Tickets (the delta, key by key), Decisions, Open (each with whom) and Next',
};

const toWords = (target: AudienceTarget): string => {
  if (target.kind === 'slack') return `Slack: ${target.channel}${target.thread ? `, thread ${target.thread}` : ''}${target.label ? ` “${target.label}”` : ''}`;
  if (target.kind === 'confluence') return `Confluence page ${target.page}, the section under the heading “${target.section}”${target.label ? ` (“${target.label}”)` : ''}`;
  return `a prep sheet for the meeting “${target.meeting}”${target.label ? ` (“${target.label}”)` : ''}, never sent`;
};

const DRAFT_TO: Readonly<Record<AudienceTarget['kind'], string>> = {
  slack: `{"kind": "slack", "channel" (the channel id, C… or D…: resolve a #name with the Slack MCP), "thread" (only for a thread), "label"}, Slack mrkdwn, ${MESSAGE_MAX} characters at most`,
  confluence: `{"kind": "confluence", "page" (the page id), "section" (the heading, exactly as given), "label"}, Markdown for the section's body without its heading, ${PAGE_MAX} characters at most; it replaces that section's body`,
  prep: `{"kind": "prep", "meeting" (as given), "label"}, Markdown: what to raise, what is open and with whom, what to ask for; ${PAGE_MAX} characters at most. It is never sent: the user takes it into the meeting`,
};

const dayWords = (at: number | undefined): string => (at === undefined ? 'never' : new Date(at).toISOString().slice(0, 10));

const cadenceWords = (audience: Audience): string =>
  audience.cadence.days.length ? `${audience.cadence.days.map((d) => DAY_NAMES[d]).join(', ')} at ${audience.cadence.at}` : 'on request only';

const peopleWords = (audience: Audience, people: readonly Person[]): string =>
  audience.people.length ? audience.people.map((slug) => people.find((p) => p.slug === slug)?.name ?? slug).join(', ') : 'nobody named';

const list = (label: string, items: readonly string[], empty: string): string => (items.length ? `${label}:\n${items.map((i) => `  - ${i}`).join('\n')}` : `${label}: ${empty}`);

/** What changed for one audience since its last update, worked out by Beluga: the agent writes from these. */
export const updateFacts = (item: InitiativeView, audience: Audience, people: readonly Person[]): string => {
  const last = lastUpdateOf(item, audience.id);
  const since = last ? Date.parse(last.at) : undefined;
  const delta = last ? deltaLines(ticketDelta(last.tickets, item.tickets?.tickets ?? [])) : undefined;
  return [
    `Since: ${last ? `${dayWords(since)}, the last update to them (${last.file})` : 'never updated: give where it stands now'}`,
    list('What happened (timeline.md)', timelineSince(item.timeline, since).slice(0, 40).map((e) => `${e.day || 'undated'} [${e.kind}]: ${e.text}`), 'nothing new on the timeline'),
    delta === undefined ? 'Ticket delta: none to compare with yet; summarise tickets.json as it stands' : list('Ticket delta (tickets.json against the last update)', delta, 'no ticket changed'),
    list('Decisions made', decisionsSince(item, since), 'none'),
    list('Open, and with whom', openWithWhom(item, people), 'nothing waits on anyone'),
  ].join('\n');
};

const HOW = [
  'A stakeholder update is a draft in outbox.json with "audience" set to the audience\'s id and "to" from its target; write it from the facts given for it and the memory, in its tone, in the voice of the user, about this initiative alone.',
  'One open draft per audience: when one for it is still a draft, rewrite its text instead of adding another.',
  'Never send one yourself, and never write updates.json or updates/: Beluga keeps each update once the user sends it (or keeps a prep sheet).',
].join(' ');

const audienceLine = (item: InitiativeView, audience: Audience, people: readonly Person[], now: number): string => {
  const last = lastUpdateOf(item, audience.id);
  const due = isUpdateDue(item, audience, now);
  const pending = pendingUpdateOf(item, audience.id);
  const state = due ? 'DUE: draft its update in this check-in' : pending ? `draft ${pending.id} waits for the user` : `next due ${dayWords(nextDueOf(item, audience, now))}`;
  return `- ${audience.name} (id ${audience.id}): ${peopleWords(audience, people)}; tone ${audience.tone}; ${cadenceWords(audience)}; to ${toWords(audience.target)}; last sent ${dayWords(last ? Date.parse(last.at) : undefined)}; ${state}`;
};

/** The brief's audiences: who gets updates and how, which are due, and the facts for those. */
export const audiencesBrief = (item: InitiativeView, people: readonly Person[], now: number): string => {
  const audiences = item.audiences ?? [];
  if (!audiences.length) return '';
  const due = audiences.filter((a) => isUpdateDue(item, a, now));
  const facts = due.map((a) => `Facts for ${a.name} (${a.id}):\n${updateFacts(item, a, people)}`);
  return [
    `Stakeholder updates (audiences, in initiative.json; sent ones are kept in ${UPDATES_DIR}.json and ${UPDATES_DIR}/):`,
    ...audiences.map((a) => audienceLine(item, a, people, now)),
    HOW,
    `Tones: short is ${TONE_HOW.short}; detailed is ${TONE_HOW.detailed}.`,
    `"to" by target: slack ${DRAFT_TO.slack}; confluence ${DRAFT_TO.confluence}; prep ${DRAFT_TO.prep}.`,
    ...facts,
  ].join('\n');
};

/** The check-in's part: Beluga marks the due ones in the brief. */
export const UPDATES_CHECK_IN = 'Last, draft the stakeholder update of every audience the brief marks DUE, from the facts given for it.';

/** The page's Draft Now: one audience's update, now. */
export const draftUpdatePrompt = (item: InitiativeView, audience: Audience, people: readonly Person[]): string =>
  [
    `Draft the stakeholder update for the audience “${audience.name}” (id ${audience.id}) now, and nothing else.`,
    `It goes to ${toWords(audience.target)}, for ${peopleWords(audience, people)}, in the ${audience.tone} tone: ${TONE_HOW[audience.tone]}.`,
    `Its draft's "to": ${DRAFT_TO[audience.target.kind]}.`,
    HOW,
    `The facts:\n${updateFacts(item, audience, people)}`,
    'Answer with one line: what the update says.',
  ].join('\n');
