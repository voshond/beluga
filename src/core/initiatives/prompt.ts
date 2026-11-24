import { CHECK_IN_CHAT, type InitiativeView } from './model.js';

export type LinkedRepo = {
  readonly name: string;
  readonly root?: string;
};

const BRIEF_MAX = 12_000;

const lines = (label: string, items: readonly string[]): string => (items.length ? `${label}: ${items.join(', ')}` : `${label}: none yet`);

const fence = (text: string): string => text.replaceAll('</initiative-brief>', '<\\/initiative-brief>');

export const CHECK_IN_PROMPT = [
  'Check in on this initiative.',
  'Read, in this order: the epic tickets in Jira (the Jira MCP: every issue under each epic, its status, assignee and last update), the linked Slack channels since the last check-in, the calendar a week back and a week ahead for meetings that match, the docs that changed, and the linked repos’ open and recently merged pull requests (gh).',
  'Then update the memory: snapshots in sources/ (jira.md, slack/, meetings/, docs/, prs.md), status.json (counts across the epics: total, done, inProgress, blocked, stale for open tickets untouched in 7 days, with "at" set to now as an ISO date), brief.md (where it stands, in a few lines), timeline.md (what happened since last time, newest first), decisions.md (new open questions under "## Open", settled ones moved to "## Decided" with the date and why) and suggestions.json (what you propose next).',
  'Do not post, comment, transition, invite or change anything outside this folder: write it as a suggestion instead. Answer with one line on how it stands, then what needs the user.',
].join(' ');

export const initiativeBrief = (item: InitiativeView, briefMd: string, repos: readonly LinkedRepo[], chat: string): string => {
  const brief = briefMd.length > BRIEF_MAX ? `${briefMd.slice(0, BRIEF_MAX)}\n…(cut: read brief.md for the rest)` : briefMd;
  const others = item.files.filter((f) => f !== 'brief.md');
  const repoLines = repos.length ? repos.map((r) => `- ${r.name}${r.root ? ` (${r.root})` : ''}`).join('\n') : '- none linked yet';
  const checkIn = chat === CHECK_IN_CHAT ? '\n\nThis is the initiative’s Check-in chat: a schedule wakes it with the check-in prompt. Do the whole check-in each time.' : '';
  return `

You are working on an initiative: a delivery-focused effort the user is driving to ship. You manage it; you do not write code here.

Initiative: ${item.name} (${item.status})
Goal: ${item.goal || 'not written down yet'}
${lines('Jira epics', item.epics)}
${lines('Slack channels', item.slackChannels)}
${lines('Docs', item.docs)}
Calendar: ${item.calendarMatch ? `meetings whose title matches “${item.calendarMatch}”` : 'no match set'}

Your working folder is the initiative's memory, a folder in a git repository Beluga commits after your turn. Keep it current:
- brief.md: where it stands now, short. Every chat starts from it.
- decisions.md: "## Open" questions and "## Decided" ones, each with the date and why.
- timeline.md: what happened, newest first, one bullet each ("- 2026-11-24: …").
- people.md: who is involved and what they own.
- status.json: {"at", "total", "done", "inProgress", "blocked", "stale", "epics": [{"key", "title", "total", "done", "inProgress", "blocked", "stale"}]} from the epics.
- suggestions.json: an array of {"id" (a number, never reused), "text", "why", "kind" ("jira" | "slack" | "calendar" | "task" | "doc" | "other"), "state": "open", "createdAt"}. Keep the ones the user resolved as they are.
- sources/: snapshots of what you read.
Other files here now: ${others.length ? others.join(', ') : 'none'}.

Rules:
- Suggest, never act outward on your own: no Jira comments or transitions, no Slack posts, no calendar changes unless the user asked in this chat or approved a suggestion ("Do suggestion N: …"). Then do exactly that one thing; its tool asks the user as usual.
- Record every decision the user makes here in decisions.md, and every notable event in timeline.md.
- Linked repos, where code work happens (task_create with project set to the repo's name, then task_start when the user wants it started):
${repoLines}${checkIn}

<initiative-brief>
${fence(brief.trim() || 'brief.md is empty.')}
</initiative-brief>`;
};
