import { type DiscoveryStep, SIZING_DIR } from './discovery-model.js';
import type { InitiativeView } from './model.js';

export const DEMO_SHAPE = '{"repo" (the linked repo’s name), "task" (the board task’s key, e.g. "BF-1"), "title", "state" ("drafted" until the user says start, "started" once task_start ran, "done" once its proof came back)}';

export const PROPOSAL_SHAPE = '{"at" (now, an ISO date), "epics": [{"title", "why", "key" (only once it exists in Jira), "stories": [{"title", "key" (only once it exists)}]}]}';

const SIZE_HOW = [
  'Answer it from BigQuery, read-only: find the tables with sentinel_try_source and a bigquery source (read the schema from the dataset’s INFORMATION_SCHEMA.COLUMNS first, filter on the partition column, keep each query under 1 GB), look at a few real rows, then run the query that answers it.',
  `Write the finding to ${SIZING_DIR}/<a short name>.md: a heading with the question, the answer in a line or two with its numbers, what it counts and leaves out, and the exact query in a \`\`\`sql block.`,
  `Beluga keeps every file in ${SIZING_DIR}/ as an artifact when your turn ends and moves it out of there: never write the same finding twice.`,
  'Add the answer to evidence.md with the artifact’s file name as its source. When a column’s meaning is not clear, ask instead of guessing.',
].join(' ');

const DEMO_HOW = (repo: string): string =>
  [
    `Start a throwaway demo for stakeholders in ${repo}.`,
    'Write its brief from the goal, problem.md, evidence.md and prd.md: what a stakeholder sees, the one flow it shows, what is faked (hardcoded data, no tests, no migrations, no production paths), and that its proof (screenshots, a short recording, a preview link) goes back to this initiative with report_to_initiative.',
    `Create it with task_create, project "${repo}", that brief as its brief, and do not start it.`,
    `Write demo.json: ${DEMO_SHAPE}, with "state": "drafted".`,
    'Then add a "decision" suggestion “Start the demo task KEY in REPO?” with the options "Start it" and "Not yet". Only when the user decides “Start it”, call task_start for it and set demo.json’s state to "started".',
  ].join(' ');

const PROPOSE_HOW = [
  'Propose this initiative’s delivery: the epics and their stories, from the goal, prd.md, evidence.md and what the demo showed.',
  `Write proposal.json: ${PROPOSAL_SHAPE}. Say each epic’s why in a line.`,
  'Then add one "jira" suggestion: “Create the N epics and their stories in Jira as proposal.json has them”, naming the Jira project; when the project is not clear, make that a "decision" first.',
  'Create nothing in Jira before the user approves. Once they did and you created them, write each key into proposal.json and tell the user to press Move to Delivery on the page, which links the epics and sets the initiative active.',
].join(' ');

const STEP_PROMPT: { readonly [K in DiscoveryStep['step']]: (step: Extract<DiscoveryStep, { step: K }>) => string } = {
  problem: () =>
    'Work out the problem with me. Write problem.md (who has it, how it shows, what it costs, why now) and evidence.md (what we know, each point with its source: a doc, a thread, a ticket, a number), from the goal, the doc sources and the threads it follows. Then ask me, a few at a time, what you could not find; put what stays open in decisions.md under "## Open".',
  size: (step) => `Size it: ${step.question}\n\n${SIZE_HOW}`,
  prd: () =>
    'Draft the PRD in prd.md from the goal, problem.md, evidence.md and the sizing artifacts: Problem, Goals and non-goals, Who it is for, What we know (with the numbers and their sources), The solution (flows, not screens), Success (how we will know), Risks and open questions. Write it for stakeholders, plainly. Rewrite it whole when it exists, keeping what the user changed. Answer with what is still thin.',
  confluence: () =>
    'Put prd.md on Confluence through the outbox: draft it in outbox.json as {"to": {"kind": "confluence", "file": "prd.md", "title", "space" (the space key), "page" (a page id, to write over a page that exists), "parent" (a parent page id, optional), "label"}, "text" (one line on what goes out), "why", "state": "draft"}. Ask me for the space or the page first when the docs it follows do not show it. Do not create or change a page yourself: I send it from the chat.',
  demo: (step) => DEMO_HOW(step.repo),
  propose: () => PROPOSE_HOW,
};

export const discoveryStepPrompt = (step: DiscoveryStep): string => (STEP_PROMPT[step.step] as (s: DiscoveryStep) => string)(step);

export const DISCOVERY_CHECK_IN_PROMPT = [
  'Check in on this initiative, which is in discovery: it has no epics yet, so skip Jira tickets entirely and leave tickets.json and status.json alone.',
  'Read every Slack conversation it follows (each channel since the last check-in, each thread by its link with slack_read_thread), the calendar a week back and a week ahead for every meeting it follows (prep notes and follow-ups in sources/meetings/), and every doc source (refresh its snapshot in sources/docs/ as its line in the brief says).',
  'Read the artifacts sent since the last check-in (sizing findings and the demo’s proof), and the demo: demo.json, its task on the board and its worktree’s progress.',
  'Then: add what is new to evidence.md with its source; go through the open questions in decisions.md and move the ones that got answered to "## Decided" with the date and why; note the demo’s state; update brief.md (where it stands, in a few lines) and timeline.md (what happened since last time, newest first).',
  'In suggestions.json, propose the next discovery step when it is due (work out the problem, size it, draft the PRD, start the demo, propose the epics), and make every question only the user can settle a "decision" with its "options".',
  'Do not post, comment, create or change anything outside this folder: write it as a suggestion instead. Answer with one line on how it stands, then what needs the user.',
].join(' ');

export const discoveryBrief = (item: Pick<InitiativeView, 'status'>): string =>
  item.status !== 'discovery'
    ? ''
    : `

This initiative is in discovery: an idea, not yet delivery, with no epics required. Work it out with the user, step by step: the problem, the evidence, its size, the PRD, a throwaway demo for stakeholders, then the epics. Keep, beside the files above:
- problem.md: who has the problem, how it shows, what it costs, why now. The page shows it.
- evidence.md: what we know, each point with its source. The page shows it.
- ${SIZING_DIR}/: sizing findings, each with its query; Beluga moves each into artifacts when your turn ends.
- prd.md: the PRD, which the page shows. It goes to Confluence only through the outbox.
- demo.json: the demo task, ${DEMO_SHAPE}.
- proposal.json: the proposed epics and stories, ${PROPOSAL_SHAPE}.
Nothing goes to Jira or Confluence, and no task starts, until the user approved it. The page's Move to Delivery sets the initiative active with the epics you created: never change "status" or "epics" in initiative.json yourself.`;
