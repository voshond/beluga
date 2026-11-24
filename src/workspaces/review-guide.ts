import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { belugaHome } from './store.js';

/**
 * A project's review guide (docs/review-guide.md): the rules its reviewers keep sending back, and a
 * short brief that makes every agent follow them. Kept by Beluga per project, never in the repository.
 * Your own runs there get the brief, and every pull request your agent opens is checked against the guide first.
 */

const GUIDE = 'guide.md';
const BRIEF = 'brief.md';
const PROMPT = 'prompt.md';

/** Where the brief names the guide: Beluga puts its path there for each run. */
export const GUIDE_PATH_MARK = '{{guidePath}}';

export const reviewGuidesDir = (): string => path.join(belugaHome(), 'review-guides');

/** One folder per project, by its folder's name and where it is (two checkouts named alike stay apart). */
export const reviewGuideDir = (root: string): string => path.join(reviewGuidesDir(), `${path.basename(root)}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`);

export const reviewGuideFile = (root: string): string => path.join(reviewGuideDir(root), GUIDE);
export const reviewBriefFile = (root: string): string => path.join(reviewGuideDir(root), BRIEF);
const promptFile = (root: string): string => path.join(reviewGuideDir(root), PROMPT);

export type ReviewGuideInfo = {
  readonly updatedAt: number;
  readonly size: number;
  /** It has the short brief agents get in every run, not only the guide. */
  readonly brief: boolean;
};

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
};

/** The project's guide as it is now, or undefined when it has none. */
export const reviewGuideInfo = (root: string): ReviewGuideInfo | undefined => {
  try {
    const stat = statSync(reviewGuideFile(root));
    if (!stat.isFile() || stat.size === 0) return undefined;
    return { updatedAt: stat.mtimeMs, size: stat.size, brief: Boolean(readText(reviewBriefFile(root))) };
  } catch {
    return undefined;
  }
};

export const ensureReviewGuideDir = (root: string): string => {
  const dir = reviewGuideDir(root);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Take the guide and the brief out (the prompt that writes them stays). */
export const removeReviewGuide = (root: string): void => {
  rmSync(reviewGuideFile(root), { force: true });
  rmSync(reviewBriefFile(root), { force: true });
};

export const DEFAULT_REVIEW_GUIDE_PROMPT = `Set up the review guide for {{project}} (the repository at {{root}}) from its pull request review history, plus a short brief that Beluga gives every agent working in it. Beluga keeps both outside the repository: never commit, push or open a pull request for them, and change nothing in {{root}}.

## 1. Research (read-only)

Use the gh CLI, run from {{root}} (or with -R). If gh is not authenticated, stop and tell me; do not write a "final" guide without review history.

1. Fetch ALL human inline review comments on all PRs (\`repos/<owner>/<repo>/pulls/comments\`, paginated, skip bots). Read every one in chunks; don't sample.
2. Join reply threads (\`in_reply_to_id\`) to their parent comment and read each one to the end. State the rule each thread SETTLED on, not what the first comment said. Note accepted exceptions, pushback and topics deferred as tech debt.
3. Read the PR conversation comments (\`issues/comments\`) and the review summaries for process expectations: PR titles, scope, translations, screenshots, lockfiles, CI.
4. Identify AI-written or AI-assisted PRs and the feedback typical of them.
5. Survey the current code: data fetching, pagination, types and enums, i18n setup and locale files, permissions and flags, shared helpers and components, styling, tests, lint/format/CI config, package scripts. Find one canonical file to copy for each pattern. Note any stale docs or agent-instruction files (README, copilot-instructions, .cursorrules).
If there are a lot of comments, split the research across up to three parallel sub-agents: older comments, reply threads plus discussions, and the code survey.

## 2. Write {{guide}} in EXACTLY this structure

\`\`\`
# <repo-name> code review guide

> **Status:** <Final | Working draft>. <What it is based on>, <YYYY-MM-DD>.

## For people who do not write code
<2 short paragraphs: what the guide is for; how to brief an agent with it and what to check when its PR comes back. Say that terms are in the glossary at the end.>
<"What reviewers send back most often:" followed by 4–6 plain-language bullets>

## Rules
<One sentence: each rule states what to do, why, and which file to copy; areas are ordered by how often reviewers raise them.>

### <Area>
- **<Imperative rule sentence.>** <One-sentence reason.> Copy \`<path>\`.

**Wrong:**

\`\`\`<lang>
<minimal snippet>
\`\`\`

**Right:**

\`\`\`<lang>
<minimal snippet>
\`\`\`

## AI pitfalls

| Smell | Do instead |
| --- | --- |

## Patterns to copy

| Need | File | What to copy |
| --- | --- | --- |

## Checks before a pull request
<One line on the runtime and package manager.>
\`\`\`sh
<the real commands from package.json, one per line>
\`\`\`
<One short paragraph on what each command does and on gaps, e.g. "CI does not run X".>
- [ ] <8–12 checklist items: behaviour and scope, translations, type escapes, comments and debug code, reuse, loading/empty/error/disabled states, lockfile, UI screenshots, honest reporting of checks run>

## Known gaps and open decisions

| Area | Observation | Team decision needed |
| --- | --- | --- |

## Research still required        <only when Status is Working draft>

## Glossary

| Term | Meaning |
| --- | --- |
\`\`\`

Rules for the content:
- Areas are H3 under "## Rules", ordered by how often reviewers flagged them.
- Every rule is one bullet starting with a bold imperative sentence. Example blocks are optional; when present they are separate, valid-on-their-own blocks labelled \`**Wrong:**\` and \`**Right:**\`. Never put ❌/✅ markers inside a code block.
- NO citations: no PR numbers, reviewer names or quotes. Agents must not go looking up old PRs.
- Every cited path is relative to the repository root and must exist in {{root}}. Check them with a script before you finish.
- Examples use real identifiers from the current code and contain no code comments.
- Where reviewers disagreed or the code is inconsistent, put the point in "Known gaps and open decisions". Do not decide it.
- The glossary is plain language for non-developers. Group related terms in one row, e.g. "Query; mutation; query key".

## 3. Write {{brief}} in EXACTLY this structure

\`\`\`
# Repository guidance

Before editing code, read \`${GUIDE_PATH_MARK}\` and the pattern files it names for the area you are changing. Before finishing, check your final diff against its "AI pitfalls" table and "Checks before a pull request".

- <3–6 repo-specific bullets: the most frequent review rules, one line each>
- Keep changes focused on the requested behavior. Do not add speculative fallbacks, compatibility layers, casts, duplicated helpers, obvious comments, or unrelated refactors.
- If guidance conflicts with current code or another applicable instruction, surface the conflict rather than silently inventing a new convention.
- The guide stands on its own; do not look up old pull requests to interpret it.
- Never copy the guide into the repository or commit it.

If the guide is missing, say so before relying on its contents. Do not claim to have read it.

## Before you finish

- [ ] <the real check commands> pass
- [ ] <3–4 repo-specific items>
- [ ] The diff contains no unrelated cleanup, lockfile churn, debug output or code comments

Report which checks you actually ran, and anything that did not pass or could not run.
\`\`\`

Write \`${GUIDE_PATH_MARK}\` exactly like that: Beluga puts the guide's path there for each agent. Keep the brief under 30 lines. If the guide is a Working draft, add the bullet: "The guide is a provisional draft; do not treat its open decisions as settled rules."

## 4. Deliver

- Write only those two files, at exactly those paths. Create or change nothing in {{root}}: no docs, AGENTS.md, CLAUDE.md, .claude/ or .codex/ files, no .git/info/exclude edits, no commits.
- Finish with a plain-language summary: the top themes, which open decisions to raise with the team, and whether the guide is Final or a Working draft.`;

/** Your own prompt for this project's guide, or undefined while it's the built-in one. */
export const customReviewGuidePrompt = (root: string): string | undefined => {
  const text = readText(promptFile(root));
  return text && text !== DEFAULT_REVIEW_GUIDE_PROMPT.trim() ? text : undefined;
};

/** Save the prompt that writes this project's guide ('' or the built-in text: back to the built-in one). */
export const saveReviewGuidePrompt = (root: string, text: string): void => {
  const value = text.trim();
  if (!value || value === DEFAULT_REVIEW_GUIDE_PROMPT.trim()) {
    rmSync(promptFile(root), { force: true });
    return;
  }
  ensureReviewGuideDir(root);
  writeFileSync(promptFile(root), `${value}\n`);
};

/** The prompt a Generate run gets: yours or the built-in one, with the project and where to write filled in. */
export const reviewGuidePrompt = (root: string, project: string): string =>
  (customReviewGuidePrompt(root) ?? DEFAULT_REVIEW_GUIDE_PROMPT).replaceAll('{{project}}', project).replaceAll('{{root}}', root).replaceAll('{{guide}}', reviewGuideFile(root)).replaceAll('{{brief}}', reviewBriefFile(root));

/** What your own runs in a project with a guide are told: its brief (the guide's path put in), then to check against it before any pull request. */
export const reviewGuideAppend = (guide: string, brief?: string): string =>
  [
    '',
    brief ? `This project's review guidance (kept by Beluga, outside the repository):\n<review_guidance>\n${brief.replaceAll(GUIDE_PATH_MARK, guide)}\n</review_guidance>` : `This project has a review guide at \`${guide}\` (kept by Beluga, outside the repository). Before editing code, read the parts of it for the area you change.`,
    `Before you open or update a pull request (gh pr create, gh pr edit, or a push to a branch with one), check your diff against \`${guide}\`: its rules, its "AI pitfalls" table and its "Checks before a pull request". Fix what breaks it and run its checks first. Never copy the guide into the repository.`,
  ].join('\n');

/** The same for a project as its files are now ('' when it has no guide). */
export const buildReviewGuideAppend = (root: string): string => (reviewGuideInfo(root) ? reviewGuideAppend(reviewGuideFile(root), readText(reviewBriefFile(root))) : '');

/** What a pull request your agent writes does first, in a project with a guide (pr.ts adds it to the PR prompt). */
export const buildReviewGuidePrStep = (guide: string): string =>
  [
    `Before you push or open the pull request, check the work against this project's review guide, \`${guide}\` (kept by Beluga, outside the repository: never copy or commit it):`,
    '1. Read it, and the pattern files it names for the areas this diff touches.',
    '2. Go through the diff against its rules, its "AI pitfalls" table and its "Checks before a pull request" list. Fix and commit what breaks one; leave anything outside this change alone.',
    '3. Run the check commands it lists, and fix what fails because of this change.',
    '4. In the description, add a "## Checked" section: the checks you ran and their result, and anything you could not run or that did not pass.',
  ].join('\n');
