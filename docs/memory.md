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

An agent's write goes in directly, with no Keep / Discard card: you asked it to remember, or it saw something worth keeping. It is never silent, though: each write shows under the agent's answer with Undo (see below), and you can change or delete any entry in Settings at any time. The reflection pass (below) proposes entries for you to keep instead.

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

## Reflection: what to remember when work ends

When a piece of work ends, Beluga looks back at the conversation once and proposes what is worth keeping: a correction you gave, a preference you showed, something about the project that cost time to find out (BLG-96, `src/core/memory/reflection.ts`). Nothing is written before you answer.

- **When it runs.** When a worktree merges (the merged divider in its chat, whatever merged it: Beluga's Merge, Merge When Ready, GitHub, the main folder), and when you pick **Look Back** on a chat or worktree in the sidebar (`memory.reflect`). At most once per conversation per trigger: a second Look Back says it was done already. Idle chats don't trigger it.
- **What it reads.** The conversation's messages view (what `read_chat` reads, no tool output), secrets redacted, newest 30,000 characters; your memory about you and the project's as they are now, with their ids; and what you discarded before.
- **What it skips.** Anything not yours: a friend's conversation, a worktree you share, the room, an agent thread. Conversations under 6 messages, or with fewer than 3 of yours, get no pass and no card.
- **The model.** One turn, no tools, through the same one-off call Full Autopilot's stand-in uses (`session.standIn`, your default agent's runtime), on a small model: `haiku` unless you pick another in Settings › Skills & instructions › Learn from your conversations. The switch there turns it off. It uses your agent's tokens.
- **What it proposes.** At most 3 per pass and 10 waiting at once. Each is one entry about you or the project, or a change to an existing entry (by its id). A proposal is dropped when it is already remembered, already waiting, was discarded before, is over 300 characters, or looks like a secret (the same check every memory write makes). Most conversations have nothing new: then no card.
- **The card.** Each proposal is a `decision` card in Needs You, on the Mac and the phone, with the bell's notice: **Keep** (or **Update** for a change) and **Discard**. Review shows why it is worth keeping and the entry, or for a change the entry now and after. Keep writes it through `MemoryStore` as yours (`memory.keepProposal`, the cap applies); an Update is refused when the entry changed or was removed since. Discard (`memory.discardProposal`) writes nothing, and its text is remembered so it isn't proposed again.
- **A restart.** Waiting proposals, the last 200 discarded texts and which conversations were looked back at live in `~/.beluga/memory-reflection.json` (0600). A proposal that would hold a secret is never written there.

### The skill look: a skill from the work, or a fix to one

The same pass then asks a second question (BLG-106, `src/core/memory/reflection-skills.ts`): should this work have left a shared skill behind, and did a skill the run used turn out wrong? An agent only proposes a skill when it remembers to (docs/agent-setup.md); this catches the rest. It only proposes, like everything here.

- **When it runs.** After the memory look, in the same pass, and only when it can pay off: the agent ran at least 8 steps in the conversation (multi-step work), or a run loaded one of your shared skills. A short or simple conversation gets the memory look alone. No call either when 10 skill proposals already wait, or when nothing may come of it (below).
- **What it reads.** The activity view: the messages plus every step the agent ran, taken from the step book (`runStepsFrom`; a chat card itself keeps only its newest 6 steps). A shell command is read whole, up to 500 characters, not as the card's 80-character line, and a failed step is marked `[failed]`. Secrets are redacted, newest 60,000 characters. It also gets the names and descriptions of the skills you have, what waits, what you discarded, and the current SKILL.md of each skill the run used (at most 3). Why the steps and not only the messages: a skill needs the commands that really ran, and an answer rarely spells them all out.
- **The rules.** When a skill is right comes from one text, `src/shared/skill-rules.ts`, that an agent's own instructions (`buildSkillProposeAppend`) are built from too: multi-step work you are likely to want again; a fix when a skill that was followed was wrong, out of date or left out a step. Never for a one-off, what the project's docs say, what fits one repo, or a preference (that is memory).
- **The model.** Its own call on a stronger model, since a thin skill misleads every later run: `sonnet` unless you pick another (Settings › Skills & instructions › Learn from your conversations › Skill model, `reflectionSkillModel`). **Also propose skills** (`reflectionSkills`) turns only this look off; the main switch turns off both.
- **What it costs.** Per merged worktree: the memory look as before (up to about 8,000 tokens in on the small model), and, for multi-step work only, one more call of up to about 15,000 tokens in (60,000 characters) plus the used skills' text, and up to a SKILL.md out, on the stronger model. A conversation that is not multi-step work costs nothing more.
- **What it proposes.** At most one skill per pass: a new one (the Keep / Discard card with the whole SKILL.md) or a change to one the run used (the Update / Discard card showing what changes). They are the cards an agent's own proposal makes, from "Beluga", and pass the same checks (`proposeNewSkill`, `proposeSkillChange`): name, frontmatter, no secret, name not taken, at most 10 waiting. A draft that fails one is dropped: no card.
- **What it drops besides.** A new skill when the agent already proposed one in that conversation (under any name), or when there were under 8 steps. A body under 300 characters, one with no commands at all, or one where none of its commands appear in the conversation (invented steps). A fix for a skill the run did not use, one the agent already proposed a fix for, or one without a line quoted word for word from the conversation that shows the skill was wrong: that it was used is not enough. Anything already there, already waiting, or discarded before.
- **Discard.** Discard on any skill card, an agent's too, is remembered in `~/.beluga/memory-reflection.json` (the last 100): a new skill by its name and description, a fix by the skill's text it was against, so the same fix can come up again only once the skill changed.
- **Trouble.** When the skill look fails after the memory look worked, the memory proposals stand and the skill look is not tried again for that trigger (Look Back still can, once).

## Claude Code's own memory

Claude Code keeps a memory of its own per project. Beluga doesn't touch it, and Claude runs get Beluga's memory on top of it. The instructions tell every agent so: keep using your runtime's own memory, and put what any agent should know in Beluga's, since that is the one every runtime shares.

## Settings

Settings › Skills & instructions › Memory: pick About you or a project, change an entry in place (it saves when you leave the field), delete it, or add one. Your edits are checked like an agent's: the cap applies and secrets are refused. The menu lists every project you have, plus any project with a memory that is no longer in your list.

## Phone

Settings › Memory on the phone shows both, read-only (`memory.list`, protocol 1.62). Changes are made on the Mac.

## For later

- The reflection pass's token use is not in the Usage tab yet: side calls (`session.standIn`) are not counted there.
- BLG-100 (team memory) adds a project memory teammates share, next to this one.
