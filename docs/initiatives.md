# Initiatives

An **initiative** is a place to drive one thing to ship: the Jira epic, the Slack threads, the meetings, the decisions and the docs around it. It is delivery-focused, not a metrics dashboard. Beluga's "projects" keep their meaning (a repository); an initiative links to some of them as its repos.

The agent **suggests, the user approves**. It never writes to Jira, Slack or the calendar on its own: what it would do outward goes into `suggestions.json`, and approving one sends it into the initiative's chat, where the outward tool asks as any tool does.

## 1. The memory repo

One git repository, one folder per initiative. Its path is kept in `~/.beluga/initiatives.json` (`{ "root": "~/…" }`), `~/Documents/GitHub/initiatives` by default. Beluga runs `git init` on first use (with a `README.md` and a `.gitignore` that leaves out `.beluga/`). It never pushes; a remote is yours to add.

```
initiatives/
├── README.md
└── <slug>/
    ├── initiative.json   name, goal, status, epics, slackChannels, people, calendarMatch, docs, repos
    ├── brief.md          where it stands now: every chat starts from it
    ├── decisions.md      "## Open" and "## Decided", each with the date and why
    ├── timeline.md       what happened, newest first, one bullet each
    ├── people.md         who is involved and what they own
    ├── status.json       epic progress from the last check-in
    ├── suggestions.json  what the agent proposes: open, approved or dismissed
    └── sources/          snapshots: jira.md, slack/, meetings/, docs/, prs.md
```

- **The folder is the initiative.** `initiative.json` is the source of truth; the daemon reads it with zod (`InitiativeConfigSchema`, `model.ts`). A file that doesn't parse shows as the initiative's trouble on its card and page, with the folder's name as its name; nothing crashes, and editing it waits until it's fixed.
- **Slug.** The folder's name, from the name (`Checkout v2` → `checkout-v2`, `-2` when taken): lowercase letters, digits and hyphens, 40 at most.
- **status.json**: `{ at, total, done, inProgress, blocked, stale, epics: [{ key, title, total, done, inProgress, blocked, stale }] }`. "Last check-in" is its `at`.
- **suggestions.json**: `[{ id, text, why?, kind (jira | slack | calendar | task | doc | other), state (open | approved | dismissed), createdAt?, resolvedAt? }]`. The page lists the open ones.
- **Commits.** After an initiative is made or changed, after a suggestion is resolved, and after each turn in one of its chats (its done, error or denied event), the daemon commits that folder alone if anything in it changed: `<slug>: created`, `<slug>: updated`, `<slug>: suggestion 3 approved`, `<slug>: check-in 2026-11-24`, `<slug>: chat 2026-11-24`. Commits queue per repo, never sign (`commit.gpgsign=false`), and fall back to "Beluga <beluga@localhost>" when git has no identity.
- **Not in the repo.** Chat histories and agent sessions stay in `~/.beluga/initiatives/<slug>/`: `chats.json`, `chats/<id>/history.json` and `state.json`, and `local.json` (the id of its check-in sentinel, which is this computer's).

## 2. Chats

Each initiative has several chats, like the Sentinel chat (docs/sentinel.md §12): `main` first, and `checkin`, the one its check-in wakes. The channel is `initiative:<slug>:<chatId>` (`initiativeChatChannel`, `model.ts`); the protocol's `Channel`, chat refs (`shared/chat-ref.ts`) and owner-only posting (`core/workspace-sharing.ts`) know it, so only you write there and a sentinel's chat step can name it (`<you>/initiative:<slug>:checkin`).

- **Where it runs.** The initiative's folder is the agent's working folder, with `autoEdit` (files it writes there need no approval), and its own resumable session per chat (`InitiativeChats.place`, `chats.ts`).
- **What it is told.** `initiativeBrief` (`prompt.ts`, the run instructions' `initiative` piece): what an initiative is, its goal, epics, Slack channels, docs and meeting match, `brief.md` inline (in tags it can't break out of), the other memory files by name, the linked repos, and the rules: keep the memory current, record decisions, suggest instead of acting outward.
- **Board tools.** Your own runs get the task board as anywhere (`BoardWork.forRun`): `task_create` with `project` set to a linked repo's name, then `task_start` when you want it started. The chats manage; they don't code.
- **New, open, delete.** `initiatives.chatNew`, `chatOpen`, `chatDelete` (its run stops first; its messages, folder and agent transcript go). The Check-in chat can't be deleted.

## 3. The check-in

A check-in is a sentinel, not new machinery (docs/sentinel.md §13). Making an initiative makes one: `<name> check-in`, a `schedule` trigger on weekdays at 08:00 (catch-up when missed), access Look, and one `chat` step that sends `CHECK_IN_PROMPT` into the initiative's Check-in chat. Like every new sentinel it starts paused; the page's switch turns it on (`initiatives.setCheckIn`, which makes it again if it was deleted). **Check In Now** runs it once (`initiatives.checkInNow`; without Sentinel, it sends the prompt straight into the Check-in chat).

The prompt has the agent read the epics' tickets (Jira MCP), the linked Slack channels since the last check-in, the calendar a week each way, changed docs and the linked repos' pull requests (gh), then update `sources/`, `status.json`, `brief.md`, `timeline.md`, `decisions.md` and `suggestions.json`, and answer with one line on how it stands. The turn ending commits the folder.

## 4. Approving a suggestion

`initiatives.resolveSuggestion(slug, id, 'approve' | 'dismiss')` marks it in `suggestions.json` (with `resolvedAt`) and commits. Approving sends "Do suggestion N: <text>" into the initiative's open chat (its `main` when the Check-in chat is open). The run then goes through the normal approval path for any outward tool (a Jira comment, a Slack post), so nothing new is trusted.

## 5. The API and the state

`src/ipc/initiatives-api.ts` (zod only) and `initiatives-handlers.ts`: `initiatives.create(draft)` → `{ slug }`, `update(slug, patch)`, `archive(slug)` (its check-in pauses), `setRepo(slug, repo, linked)`, `setCheckIn(slug, on)`, `checkInNow(slug)`, `chatNew(slug)`, `chatOpen(slug, id)`, `chatDelete(slug, id)`, `resolveSuggestion(slug, id, decision)`, `readFile(slug, path)` (a memory file, never outside its folder). All are `mac` for the phone (`src/companion/coverage.ts`), `drive` for your other computers, and refused to external agents. Messages go through `session.submit` with the chat's channel.

The state's `initiatives` slice (`InitiativesState`: `enabled`, `root`, `items`) changes through `initiatives_init`, `initiative_put`, `initiative_remove` and `initiatives_off`. Each item is an `InitiativeView`: the config's fields, `progress`, `suggestions`, `openDecisions` (the bullets under "## Open" in `decisions.md`), `recent` (the first bullets of `timeline.md`), `files`, `checkIn` (its sentinel's id), `chats` and `trouble`. The views are `initiatives` (the list) and `initiative_page` (`slug`, and `chat`: its channel is the page's conversation).

## 6. The window (`packages/mac/src/initiatives/`)

- **Sidebar.** One Initiatives row under Sentinel (`InitiativesNav`), with how many and a badge of open suggestions.
- **The list** (`InitiativesHome`): each initiative's name, epic progress, open decisions and last check-in, and New Initiative (`NewInitiativeSheet`: name, goal, epic keys, Slack channels, docs, meetings, repos).
- **An initiative's page** (`InitiativePage`), a simple stacked page: the name with its status (Active, Paused, Shipped), Edit… and ⋯ (Archive…); Goal with the epic progress bar; the check-in switch and Check In Now; Suggestions with Approve · Dismiss; Open decisions; Recent; Repos (× to unlink, + to link); Memory, each file opening in a sheet (`MemoryFileSheet`).
- **Its chat** (`InitiativeChat`), docked beside the page as the Sentinel chat is: the chat picker (Check-in among them), New Chat, ⋯ (Delete Chat…), the conversation, its approvals and questions, and the message box.

## 7. Code, demo and tests

- `src/core/initiatives/`: `model.ts` (browser-safe: types, zod schemas, channel helpers, the reducer), `files.ts` (folders), `repo.ts` (git), `chats.ts`, `prompt.ts`, `initiatives.ts` (the service), `chat-ref.ts` (how a ref resolves), `launch.ts`, `registry.ts`, `demo.ts`.
- The demo (`npm run dev`) seeds two initiatives with progress, decisions and suggestions in a throwaway folder under the system's temp folder, removed when the daemon stops; nothing is committed there.
- `tests/initiatives-model.test.ts`, `initiatives-files.test.ts`, `initiatives-service.test.ts`.

## 8. Not yet

The phone (its views and `NeedsYou` cards for suggestions), meeting prep and follow-up of their own, dashboard tiles per initiative, a worktree joining an initiative, and opening an initiative chat from a desktop notification.
