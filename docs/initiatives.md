# Initiatives

An **initiative** is a place to drive one thing to ship: the Jira epic, the Slack threads, the meetings, the decisions and the docs around it. It is delivery-focused, not a metrics dashboard. Beluga's "projects" keep their meaning (a repository); an initiative links to some of them as its repos.

The agent **suggests, the user approves**. It never writes to Jira, Slack or the calendar on its own: what it would do outward goes into `suggestions.json`, and approving one sends it into the initiative's chat, where the outward tool asks as any tool does.

## 1. The memory repo

One git repository, one folder per initiative. Its path is kept in `~/.beluga/initiatives.json` (`{ "root": "~/…" }`), `~/Documents/GitHub/initiatives` by default. Beluga runs `git init` on first use (with a `README.md` and a `.gitignore` that leaves out `.beluga/`). Without a remote it only commits. When the branch tracks one (`git push -u`), every commit is pushed right after; a push that fails (offline, no access) leaves the commit local and goes out with the next one. A failing push shows as a warning on the Initiatives page (`backup`: when it first failed and git's last error) until a push goes through. When the daemon starts, it pushes commits still waiting.

```
initiatives/
├── README.md
└── <slug>/
    ├── initiative.json   name, goal, status, epics, slack, people, meetings, docs, repos
    ├── brief.md          where it stands now: every chat starts from it
    ├── decisions.md      "## Open" and "## Decided", each with the date and why
    ├── timeline.md       what happened, newest first, one bullet each
    ├── people.md         who is involved and what they own
    ├── status.json       epic progress from the last check-in
    ├── tickets.json      every ticket under the epics, with its pull requests
    ├── suggestions.json  what the agent proposes: open, approved or dismissed
    └── sources/          snapshots: jira.md, slack/, meetings/, docs/, prs.md
```

- **The folder is the initiative.** `initiative.json` is the source of truth; the daemon reads it with zod (`InitiativeConfigSchema`, `model.ts`). A file that doesn't parse shows as the initiative's trouble on its card and page, with the folder's name as its name; nothing crashes, and editing it waits until it's fixed.
- **Slug.** The folder's name, from the name (`Checkout v2` → `checkout-v2`, `-2` when taken): lowercase letters, digits and hyphens, 40 at most.
- **What it follows.** `slack` is a list of `{ ref, label? }`: a `#channel`, or the link of a thread or a DM (500 characters at most). `meetings` is a list of `{ match, label? }`: words a meeting's title has, or one event's link or id. A file from before BLG-114 with `slackChannels` (strings) and `calendarMatch` (one string) still reads: they become `slack` and `meetings` entries on read, and the next save writes the new shape. The goal is Markdown, 12000 characters at most.
- **status.json**: `{ at, total, done, inProgress, blocked, stale, epics: [{ key, title, total, done, inProgress, blocked, stale }] }`. "Last check-in" is its `at`.
- **tickets.json**: `{ at, tickets: [{ key, url?, summary, status, statusCategory (todo | inProgress | done), assignee?, updated?, epic?, prs: [{ url, number?, state (open | draft | merged | closed), repo?, title? }] }] }` (`TicketsSchema`). The agent writes it, so the read forgives how a state is spelled (Jira's `new` and `indeterminate`, `MERGED`, a `null` for nothing); a file that still doesn't parse is the initiative's trouble, and its table stays empty.
- **outbox.json**: the messages drafted for you to send (see §5, The outbox).
- **suggestions.json**: `[{ id, text, why?, kind (jira | slack | calendar | task | doc | decision | other), options?, answer?, state (open | approved | dismissed), createdAt?, resolvedAt? }]`. The page lists the open ones.
- **Commits.** After an initiative is made or changed, after a suggestion is resolved, and after each turn in one of its chats (its done, error or denied event), the daemon commits that folder alone if anything in it changed: `<slug>: created`, `<slug>: updated`, `<slug>: suggestion 3 approved`, `<slug>: check-in 2026-11-24`, `<slug>: chat 2026-11-24`. Commits queue per repo, never sign (`commit.gpgsign=false`), and fall back to "Beluga <beluga@localhost>" when git has no identity.
- **Not in the repo.** Chat histories and agent sessions stay in `~/.beluga/initiatives/<slug>/`: `chats.json`, `chats/<id>/history.json` and `state.json`, and `local.json` (the id of its check-in sentinel, which is this computer's).

## 2. Chats

Each initiative has several chats, like the Sentinel chat (docs/sentinel.md §12): `main` first, and `checkin`, the one its check-in wakes. The channel is `initiative:<slug>:<chatId>` (`initiativeChatChannel`, `model.ts`); the protocol's `Channel`, chat refs (`shared/chat-ref.ts`) and owner-only posting (`core/workspace-sharing.ts`) know it, so only you write there and a sentinel's chat step can name it (`<you>/initiative:<slug>:checkin`).

- **Where it runs.** The initiative's folder is the agent's working folder, with `autoEdit` (files it writes there need no approval), and its own resumable session per chat (`InitiativeChats.place`, `chats.ts`).
- **What it is told.** `initiativeBrief` (`prompt.ts`, the run instructions' `initiative` piece): what an initiative is, its epics, every Slack conversation and meeting it follows with how to read each (a channel since the last check-in, a thread by its link with the Slack MCP's `slack_read_thread`, a meeting by title words or by its event), every doc source with how to read it and where its snapshot goes, its goal and `brief.md` inline (each in tags it can't break out of), the other memory files by name, the linked repos, and the rules: keep the memory current, record decisions, suggest instead of acting outward.
- **Board tools.** Your own runs get the task board as anywhere (`BoardWork.forRun`): `task_create` with `project` set to a linked repo's name, then `task_start` when you want it started. The chats manage; they don't code.
- **New, open, delete.** `initiatives.chatNew`, `chatOpen`, `chatDelete` (its run stops first; its messages, folder and agent transcript go). The Check-in chat can't be deleted.

## 3. The check-in

A check-in is a sentinel, not new machinery (docs/sentinel.md §13). Making an initiative makes one: `<name> check-in`, a `schedule` trigger on weekdays at 08:00 (catch-up when missed), access Look, and one `chat` step that sends `CHECK_IN_PROMPT` into the initiative's Check-in chat. Like every new sentinel it starts paused; the page's switch turns it on (`initiatives.setCheckIn`, which makes it again if it was deleted). **Check In Now** runs it once (`initiatives.checkInNow`; without Sentinel, it sends the prompt straight into the Check-in chat).

The prompt has the agent read the epics' tickets (Jira MCP), every Slack conversation it follows, the calendar a week each way for every meeting it follows (prep notes for one that is coming, follow-ups for one that happened, in `sources/meetings/`), every doc source and the linked repos' pull requests (gh), then update `tickets.json`, `sources/`, `status.json`, `brief.md`, `timeline.md`, `decisions.md` and `suggestions.json`, and answer with one line on how it stands. The turn ending commits the folder. The Check-in chat's instructions carry the current prompt too, so a check-in sentinel made by an older version still does the whole of it.

**The tickets.** `TICKETS_PROMPT` (`prompt.ts`) is the ticket part alone: every issue under each epic (`jira_search` with `parent = KEY`), each one's pull requests from Jira's development info and from `gh pr list --search KEY` in the linked repos, written to `tickets.json`, with `status.json`'s counts set from the same tickets. The daemon never calls Jira: it sends that prompt into the Check-in chat when an initiative is made with epics, when its epics change, and on the page's Refresh (`initiatives.refreshTickets`).

**Doc sources.** `docs` in `initiative.json` is a list of `{ ref, label?, kind }`; `kind` (`confluence`, `gdoc`, `gsheet`, `gslides` or `link`) is worked out from the link (`docKindOf`, `model.ts`) when it isn't given, and an old file's plain string links become entries on read. The brief names each one with how to read it (`docLine`, `prompt.ts`): a Confluence page with the Confluence MCP's `confluence_get_page` by its page id (mcp-atlassian with `CONFLUENCE_URL`, `CONFLUENCE_USERNAME` and `CONFLUENCE_API_TOKEN` set), a Google Doc, Sheet or Slides with the calendar MCP's `drive_read_file` by its file id (calendar-api on the NAS holds both the work and the private Google account; claude.ai's Drive connector holds only one, so it's only the fallback), any other link with whatever tool can open it. Each has a snapshot at `sources/docs/<kind>-<page or file id>.md`; the check-in compares what it reads with it, writes the new one and notes in `timeline.md` what changed.

## 4. Refining the goal

`initiatives.refineGoal({ name, goal, epics, docs? })` → `{ goal }` is a side call (`agent/goal-refiner.ts`, like naming a worktree): one run with no session and no files, which returns Markdown (what shipped looks like, then Background, Scope, Acceptance and Open questions, each only when there is something true to say) and writes nowhere. On Claude it mounts only your own Jira server (a server of yours named like `jira` or `atlassian`, from Claude Code's files in your home folder) and allows only its Jira and Confluence reads; with a Google file among the docs it also mounts your `calendar` server and allows only its `drive_read_file`, `drive_get_file` and `drive_search` (`sourceReadVerdict`). With any doc attached it also gets Read, allowed only for a file Claude Code saved under its `projects/…/tool-results/` because a source was too long to answer inline (a Doc with images can be, as the gateway keeps them). Every other tool, and every write, is refused. Another runtime drafts from what was typed. The sheet and the page show the draft with Use This and Keep Mine; only Use This on the page saves, through `initiatives.update`.

## 5. Approving a suggestion

`initiatives.resolveSuggestion(slug, id, 'approve' | 'dismiss')` marks it in `suggestions.json` (with `resolvedAt`) and commits. Approving sends "Do suggestion N: <text>" into the initiative's open chat (its `main` when the Check-in chat is open). The run then goes through the normal approval path for any outward tool (a Jira comment, a Slack post), so nothing new is trusted.

A suggestion that is the user's call is a decision: `"kind": "decision"`, with `"options"` (2 to 4 short answers) the page shows as buttons, plus Other… for an answer of their own. `resolveSuggestion(slug, id, 'approve', answer)` keeps the `answer` on it and sends "Decided suggestion N: <text>\nAnswer: <answer>"; the chat records it in `decisions.md` under "## Decided" and does what follows from it. A suggestion of another kind that has `options` is a decision too.

### The outbox

A message (a Slack post or thread reply, a Jira comment) never leaves an initiative's chat on the agent's word. The agent drafts it in `outbox.json`: `[{ id, to, text, why?, suggestion?, state (draft | approved | sent | discarded), sentText?, createdAt?, resolvedAt? }]`, where `to` is `{ kind: 'slack', channel, thread?, label? }` or `{ kind: 'jira', issue, label? }` (`OutboxDraftSchema`). The chat shows the open drafts above its message box, one card at a time (`OutboxCards`): where it goes, why, the text in an editable field, and Send · Discard · Later.

Send (`initiatives.sendDraft(slug, id, text)`) marks it `approved` (keeping the edit as `sentText`, the agent's `text` as it was), keeps that one call in the daemon's memory (never in a file the agent writes), and asks the chat to make it: "Send draft N from the outbox now: <tool> with <ids>, and the message exactly as below". The chat's run gets a `vetTool` and a `preApproved` from `chatRun`: any `slack_send_message`, `slack_schedule_message` or `jira_add_comment` call (whatever the MCP server is called) is refused unless it matches a sent draft exactly (tool, channel and thread or issue, and the text, trimmed); a match is let through once, with no second card (the Send was the approval), and the draft becomes `sent` with a line in `timeline.md`. Discard (`initiatives.discardDraft`) marks it `discarded`, also with a line. An approved draft the chat didn't post (the daemon restarted, the chat was busy) shows "Send Again". External agents can't send: initiatives are refused to them.

## 6. The API and the state

`src/ipc/initiatives-api.ts` (zod only) and `initiatives-handlers.ts`: `initiatives.create(draft)` → `{ slug }`, `update(slug, patch)`, `archive(slug)` (its check-in pauses), `setRepo(slug, repo, linked)`, `setCheckIn(slug, on)`, `checkInNow(slug)`, `refreshTickets(slug)`, `refineGoal(input)`, `chatNew(slug)`, `chatOpen(slug, id)`, `chatDelete(slug, id)`, `resolveSuggestion(slug, id, decision, answer?)`, `sendDraft(slug, id, text)`, `discardDraft(slug, id)`, `readFile(slug, path)` (a memory file, never outside its folder). All are `mac` for the phone (`src/companion/coverage.ts`), `drive` for your other computers, and refused to external agents. Messages go through `session.submit` with the chat's channel.

The state's `initiatives` slice (`InitiativesState`: `enabled`, `root`, `items`, and `backup` while pushes fail) changes through `initiatives_init`, `initiative_put`, `initiative_remove`, `initiatives_backup` and `initiatives_off`. Each item is an `InitiativeView`: the config's fields (`slack`, `meetings` among them), `progress`, `tickets`, `suggestions`, `outbox`, `openDecisions` (the bullets under "## Open" in `decisions.md`), `recent` (the first bullets of `timeline.md`), `files`, `checkIn` (its sentinel's id), `chats` and `trouble`. The views are `initiatives` (the list) and `initiative_page` (`slug`, and `chat`: its channel is the page's conversation).

## 7. The window (`packages/mac/src/initiatives/`)

- **Sidebar.** One Initiatives row under Sentinel (`InitiativesNav`), with how many and a badge of open suggestions.
- **The list** (`InitiativesHome`): each initiative's name, epic progress, open decisions and last check-in, and New Initiative (`NewInitiativeSheet`: name, goal with Refine With Agent, epic keys, Slack conversations, docs and meetings as lists of rows with a label each (`RefList`; pasting several links makes a row each), repos).
- **An initiative's page** (`InitiativePage`), a simple stacked page with the whole window (no right panel, as Sentinel's pages): the name with its status (Active, Paused, Shipped), Edit… and ⋯ (Archive…); Goal, drawn as Markdown, with Refine With Agent (`GoalRefine`); the epic progress bar (done in green, in progress in blue); Tickets (`TicketsTable`: a card list like the chat's task cards, one row each with its status ring, key, summary, pull requests with their state, assignee and last update, and its Jira status as a pill; a click on the key or summary opens Jira; open ones first, grouped by epic when there are several; assignee and update hide when the page is narrow; with Refresh); the check-in switch and Check In Now; Suggestions with Approve · Dismiss (a decision: its answers, Other… and Dismiss, `DecisionRow`); Open decisions; Recent; Slack conversations, Docs (each with its kind: Confluence, Google Doc, Sheet or Slides, Link) and Meetings (`InitiativeFollows`, a link opens in Slack, the browser or the calendar); Repos (× to unlink, + to link); Memory, each file opening in a sheet (`MemoryFileSheet`).
- **Its chat** (`InitiativeChat`), docked beside the page as the Sentinel chat is: the chat picker (Check-in among them), New Chat, ⋯ (Delete Chat…), the conversation, its approvals and questions, the outbox's cards (`OutboxCards`) and the message box.

## 8. Code, demo and tests

- `src/core/initiatives/`: `model.ts` (browser-safe: types, zod schemas, channel helpers, the reducer), `files.ts` (folders), `repo.ts` (git), `chats.ts`, `prompt.ts`, `initiatives.ts` (the service), `chat-ref.ts` (how a ref resolves), `launch.ts`, `registry.ts`, `demo.ts`.
- The demo (`npm run dev`) seeds two initiatives with progress, decisions and suggestions in a throwaway folder under the system's temp folder, removed when the daemon stops; nothing is committed there.
- `tests/initiatives-model.test.ts`, `initiatives-files.test.ts`, `initiatives-service.test.ts`, `goal-refiner.test.ts`, and `packages/mac/e2e/initiatives.spec.ts` (the page, the table, Refine and the list editor against the demo).

## 9. Not yet

The phone (its views and `NeedsYou` cards for suggestions), dashboard tiles per initiative, a worktree joining an initiative, and opening an initiative chat from a desktop notification.
