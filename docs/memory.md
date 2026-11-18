# Memory

Beluga keeps a small memory of its own, so an agent on any runtime (Claude, Codex, Copilot, OpenCode, a local model) starts a run knowing what earlier runs learned. There are two kinds:

- **About you**: who you are and how you like to work. One for all your projects. Capped at 1,375 characters.
- **Per project**: a project's gotchas and conventions that the repo doesn't record. One per project. Capped at 2,200 characters.

The caps are the point. A full memory can't grow: the agent has to merge related entries or drop stale ones instead of appending forever (as Hermes Agent does).

## Where it lives

`~/.beluga/memory/user.json`, and `~/.beluga/memory/projects/<key>.json` for each project, where the key is a hash of the project's folder and the file names that folder. Writes are atomic and the files are `0600`. Each entry has an id, its text, when it was last written, and who wrote it (`you` or `agent`).

## In every run

Every run you start on this computer gets both: your memory, and the memory of the project it runs in. They are one piece of the run's instructions (`memory` in `INSTRUCTION_PIECES`, `src/agent/run-instructions.ts`), so Settings › Skills & instructions › Built-in instructions lists it. Claude gets it in its system prompt, Codex in its developer instructions, OpenCode in its instructions file and Copilot in its instructions. The agent's own terminal and a dialogue's turns get it too.

A friend's run never gets any of it: not your memory, not the project's, and not the tools. A run outside a project (Your Mac, a friend's shared worktree) gets your memory only.

## The tools

Your own runs get the `beluga_memory` server, on every runtime:

| Tool | What it does |
|---|---|
| `memory_list` | Shows both memories, each entry with its id, and how full each is. |
| `memory_add` | Adds one fact, to `user` or `project`. |
| `memory_replace` | Rewrites one entry (by its id, or a piece of text only it has). Use it to merge entries. |
| `memory_remove` | Forgets one entry. |

An agent's write goes in directly, with no Keep / Discard card: you asked it to remember, or it saw something worth keeping. It is never silent, though: each write shows under the agent's answer with Undo (see below), and you can change or delete any entry in Settings at any time. The reflection pass (BLG-96) will propose entries for you to keep instead.

A write is refused when:

- it would take the memory over its cap. The error tells the agent to merge entries with `memory_replace` or drop stale ones with `memory_remove`, then try again. A write that makes the memory smaller always goes through.
- it looks like a secret: a key, a token, a connection string with its password, a private key, or `password: …`, `token = …`. Say where access is, never what it is.
- it is already there.

## Under the agent's answer, with Undo

Each write an agent's run makes shows as a soft chip under its answer (BLG-102): "Remembered", "Changed a memory" or "Forgot", the entry's text, and whose memory it is (About you, or the project's name). Hover it for the whole text and, for a change, what it was before.

**Undo** puts it back as it was: an add is removed, a change is restored to its old text, a forgotten entry goes back where it stood. The store hands back what each write changed (the entry before and after, and its place: `MemoryStore.write` in `src/core/memory/store.ts`), and `memory.undo` undoes that one write. It refuses, and changes nothing, when:

- it was undone already (the chip says Undone);
- the entry changed again since (you edited it in Settings, or a later run did): change it in Settings instead;
- the same text is remembered again already;
- putting it back would take the memory over its cap: make room first, then undo again.

The chips are kept on the run's card in the conversation (`learned` on the agent item, `src/shared/learned.ts`), so they come back when the conversation is loaded again. Only your own runs get them; a friend's run never has your memory. The same row shows a skill the run proposed (docs/agent-setup.md) and a search of past chats (docs/chat-tools.md).

The phone shows the same chips read-only (protocol 1.63, `TurnView.learned`): what was remembered, whose memory, and "Undone on your Mac" once it was. Undo is on the Mac.

## Claude Code's own memory

Claude Code keeps a memory of its own per project. Beluga doesn't touch it, and Claude runs get Beluga's memory on top of it. The instructions tell every agent so: keep using your runtime's own memory, and put what any agent should know in Beluga's, since that is the one every runtime shares.

## Settings

Settings › Skills & instructions › Memory: pick About you or a project, change an entry in place (it saves when you leave the field), delete it, or add one. Your edits are checked like an agent's: the cap applies and secrets are refused. The menu lists every project you have, plus any project with a memory that is no longer in your list.

## Phone

Settings › Memory on the phone shows both, read-only (`memory.list`, protocol 1.62). Changes are made on the Mac.

## For later

- BLG-96 (reflection pass) proposes entries through `MemoryStore` in `src/core/memory/store.ts`.
- BLG-100 (team memory) adds a project memory teammates share, next to this one.
