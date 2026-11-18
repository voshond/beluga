# Chat tools: your agent and your other chats

Your own agent can find, read, search and message your other chats with the `beluga_chats` tools (`src/agent/chat-tools.ts`). They read the chats as Beluga keeps them (`src/core/chat-links/transcript.ts`), never a harness's own files, so Claude, Codex, OpenCode, Copilot and local models get the same answers.

| Tool | What it does |
|---|---|
| `list_chats` | Your chats and the ones shared with you, newest activity first: ref, link, title, kind, state |
| `read_chat` | One page of a chat, oldest first. `after` goes on from a page; `around` opens a page with a `search_chats` hit in its middle |
| `search_chats` | Your past conversations, searched for messages with every word you give (BLG-99) |
| `send_to_chat` | A message to another chat; limits in `guard.ts` |
| `wait_for_chat` | The answer to a message you sent |

## Who gets them

Only runs you asked for, in a chat nobody else sees (`HostChatLinks.toolsFor`). A friend's task, a guest's prompt, an external agent's run and a run in a shared worktree, the room, a DM or a group never get them: their words could ask your agent to quote your other chats. A chat you share while a run is going refuses the tools from then on (`chat_shared`). `core/chat-links/access.ts` decides each read and send.

## Searching past conversations

`search_chats` lets your agent look up how something went before ("how did we fix the tunnel last time") instead of you pasting it in. It reads what the Search page reads (`Workbench.searchSources`): open, saved and archived worktrees and chats, Your Mac's saved chats and chats shared with you. It matches words the way the Search page does (any order, any case, a word inside a longer one), with no index; the ranking is `src/core/chat-links/recall.ts`.

Each search also shows under the answer of the run that made it (BLG-102): a chip reading "Searched past chats for “…”" with the words it searched, on the Mac and, read-only, on the phone. It is kept on the run's card, so it comes back with the conversation.

- **Only what it may open, before any cap.** The run's own chat (it already has it), the room, DMs, groups and drafts (no ref names them, so `read_chat` couldn't open them), chats it may not read, Beluga's notices and runs that never answered are dropped first, so a busy room never pushes a real hit out.
- **One hit per chat.** The best match in each chat, with `more`: how many other messages there match. `read_chat` with `ref` and `around: pos` opens them.
- **Ranked by relevance.** First the hits that cover the most of the query's words (a word in the chat's title counts), then a match in the title, then the newest. `order: newest` ("where did we leave X") and `order: oldest` ("how did X start") sort by time only.
- **Loosened on a miss.** When no message has every word, it searches again for any of them, most words first; the answer says `loosened` and each hit lists the words it `matched`. Exact matches never get loosened.
- **Time bounds.** `after` and `before` take an ISO date (2026-11-01) or a span back from now (24h, 7d, 2w).
- **What a hit gives.** The chat (`ref`, `link`, `title`, `kind`, `state`), when it was said (`at`), who said it, an excerpt around the match and the messages around it: about 600 characters and two messages either side for the top hit, 240 characters and one either side for the rest.
- **Capped.** 10 chats by default, 25 at most (`moreChats` says how many more matched), and an answer stops adding hits past about 20,000 characters. Secrets and paths to secret files are redacted, as in `read_chat`.
- **Nothing found** says how to broaden the search, and both the answer and the tool's description say an empty search is no proof that something never happened.
- The run's instructions (Settings › Skills & instructions › Past conversations) tell the agent to search when a request points back, before asking you to repeat something.

Still open: no index (SQLite FTS5) and so no word-frequency ranking, no stemming ("fixed" doesn't find "fix"), no summary of the hits by a model, and every saved history is read from disk on each call.
