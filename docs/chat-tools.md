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

`search_chats` lets your agent look up how something went before ("how did we fix the tunnel last time") instead of you pasting it in. It reads what the Search page reads (`Workbench.searchSources`): open, saved and archived worktrees and chats, Your Mac's saved chats and chats shared with you. The search is `searchConversations` (`src/core/search.ts`): every word must appear, in any order and any case, newest first.

- Each hit gives the chat (`ref`, `link`, `title`, `kind`, `state`), when it was said (`at`), who said it, an excerpt of about 300 characters around the match, the messages just before and after (160 characters each), and a `pos`. `read_chat` with `ref` and `around: pos` opens the rest.
- Capped: 10 hits by default, 25 at most, and an answer stops adding hits past about 20,000 characters. Secrets and paths to secret files are redacted, as in `read_chat`.
- Left out: the run's own chat (it already has it), the room, DMs, groups and drafts (no ref names them, so `read_chat` could not open them), Beluga's notices and runs that never answered.
- The run's instructions (Settings › Skills & instructions › Past conversations) tell the agent to search when a request points back, before asking you to repeat something.

What the search does not do yet: no ranking (newest wins over most relevant), no stemming or synonyms (a word matches inside longer ones, so "fix" finds "fixed", but "fixed" doesn't find "fix"), and every saved history is read from disk on each call. An index (SQLite FTS5) is the next step if that proves too slow or too literal.
