# Skills & instructions

Settings › Skills & instructions controls what your own agents know beyond the request in front of them. It has five parts. Everything on this page applies to runs you start on this computer. A friend's or a guest's run never gets any of it.

## About this machine

A note about this computer, with one switch for all of it. When the switch is on, Beluga adds the note to every run you start: Claude gets it in its system prompt, Codex in its developer instructions, and OpenCode in its instructions file. It sits right after the room instructions, inside `<machine_context>`.

Use it for what is true of the machine rather than of a project. For example: the repos are checked out here, there are SSH keys to the NAS, and the agent may use them to check results or deploy. Say where access is, never what it is: the note is saved in `~/.beluga/settings.json` (`machineNote`, `machineNoteOn`), so don't put a password or a key in it.

## Memory

What your agents remember about you and about each project, kept by Beluga so every runtime reads the same. Pick About you or a project, change an entry in place, delete it, or add one. See [memory.md](memory.md).

## Shared skills

`~/.agents/skills/<name>/SKILL.md` is the one place for skills that both agents should have.

- **Codex** reads `~/.agents/skills` itself (its user skills scope), so it needs no link.
- **Claude Code** reads only `~/.claude/skills/<name>/SKILL.md` (or under `$CLAUDE_CONFIG_DIR`), so each skill gets a link of its own there.

New Skill asks for a name (lowercase letters, digits and dashes) and a description, then writes a SKILL.md with that frontmatter and links it for Claude. Both agents use the description to decide when to apply a skill, so saving refuses a file without one, or with a `name:` that doesn't match its folder.

Each skill shows a badge per agent:

| Badge | Meaning |
|---|---|
| Claude linked | `~/.claude/skills/<name>` is a link to the shared folder. |
| Claude not linked | There's no link yet. Repair Links adds one. |
| Claude has its own | Claude has a real folder (or a link elsewhere) by that name. It is never replaced. |
| Codex reads it | Codex finds it in `~/.agents/skills` itself. |

A single link from `~/.claude/skills/<something>` to the whole `~/.agents/skills` folder puts every skill one level too deep, so Claude never sees them. The pane points it out, and Repair Links replaces it with one link per skill. Delete removes the skill's folder and its Claude link.

On Windows, a folder link is a junction.

## Skills your agents propose

Your own runs get three tools in the `beluga_skills` MCP server, on every runtime (Claude, Codex, Copilot, OpenCode and local models):

| Tool | What it does |
|------|--------------|
| `skill_read` | Lists your shared skills (name and description), or shows one skill's SKILL.md |
| `skill_propose` | Proposes a new skill from a name, a description and a body. It shows as a "Keep / Discard" card |
| `skill_propose_change` | Proposes a whole new SKILL.md for a skill you have, with what was wrong. It shows as an "Update / Discard" card |

A proposal also shows under the answer of the run that made it (BLG-102): "Proposed the skill deploy-nas" with Keep / Discard (Update / Discard for a change). A click opens Needs You, where its card is; once you answered it the chip says Answered. On the phone the chip is read-only and says when the card waits for you.

This works like the Toolbox's `tool_propose` (docs/toolbox.md). Nothing is written until you answer. The card is in Needs You on the Mac (the bell, where Review shows the text) and on the phone (Read all). A new skill's card shows the reason and the whole SKILL.md. A change's card shows the reason and only the lines that change, with two lines around them, as Before and After.

- **Keep** writes `~/.agents/skills/<name>/SKILL.md` through the same code as New Skill, and links it for Claude. If a skill by that name appeared since, Keep refuses and the card stays.
- **Update** writes the new SKILL.md in place.
- **Discard** drops the proposal.

A proposal is refused, with the reason going back to the agent, when:

- the name is not lowercase letters, digits and dashes, or the frontmatter is missing its `name:` or `description:`;
- a new skill's name is taken (the agent is told to propose a change instead);
- a change would leave the skill as it is;
- the text holds a secret, such as a provider's key format or a `SECRET_NAME=value` line (`src/shared/key-detect.ts`). Naming a variable (`$GITHUB_TOKEN`) is fine;
- 10 proposals already wait for you.

A newer proposal for the same skill replaces the older card. Proposals you haven't answered survive a restart of Beluga (BLG-103): they are kept in `~/.beluga/skill-proposals.json` (mode 0600, written a second after a change and when Beluga stops) and their cards come back at start. A proposal holding anything a secret check refuses (in its text, the SKILL.md it changes or its reason) is never written there: it waits in memory only. The code is in `src/core/skill-proposal-file.ts`.

The run's instructions say when proposing is right: after multi-step work you'll likely want again, or when a skill it followed was wrong or incomplete. They also say when it isn't: a one-off, something the project's own docs already say, something that fits only one repo, or a preference, which belongs in memory. That piece is "Skills you propose" in Built-in instructions. A friend's, a guest's or an external agent's run never gets these tools.

Beluga also proposes skills itself when work ends (BLG-106): the reflection pass reads the steps the agent ran and proposes at most one new skill after multi-step work, or one fix to a skill the run used and that was shown wrong. Its cards are these same cards, from "Beluga", and it judges by the same rules: both texts are built from `src/shared/skill-rules.ts`. A skill the agent already proposed in that conversation is not proposed again, and a skill you discard (from an agent or from the pass) is remembered so the pass doesn't bring it back. Settings › Skills & instructions › Learn from your conversations has its switch (**Also propose skills**) and its model (`sonnet` unless you pick another). See docs/memory.md, "The skill look".

Only your own shared skills are covered. A project's skills that live in its repo and are shared with teammates are out of scope (BLG-98's open question). The code is in `src/core/skill-proposals.ts` and `src/agent/skill-tools.ts`.

## Global AGENTS.md

The editor writes `~/.agents/AGENTS.md`. Below it, two rows show whether `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` point at that file. Link makes them point at it:

- When there's no shared file yet and the agent has a file of its own, that file becomes the shared one. Its old path then links to it.
- Otherwise, a file of its own, or a link to somewhere else, is renamed to `….beluga-backup-<time>` next to it, and the toast says where it went.

On Windows, linking a file needs an administrator, so Beluga copies the file instead. The row then shows a file of its own.

## Built-in instructions

This is a read-only list of each piece Beluga adds to a run's instructions, in the order it adds them. Each piece shows when it is added (every run, worktree runs, a main folder, the terminal view, …), the file it comes from, and its text. Pieces that are written for each run (a task's brief, a plan's) show only their source. To change a piece, edit that source and open a pull request.

The list and the real instructions come from the same code, `INSTRUCTION_PIECES` in `src/agent/run-instructions.ts`, so they can't drift apart. That code is the hook: `runInstructions` joins the pieces for every run. Claude receives the result through `systemPrompt.append`, Codex through `developerInstructions`, and OpenCode through its instructions file. Your own `CLAUDE.md`, `AGENTS.md` and skills don't pass through Beluga: each agent loads them itself on your own runs.

## Zsh

Agents write their commands for bash, and run them in zsh on most Macs. There some of them stop: an unquoted glob or URL that matches nothing (`--include=*.ts`, `curl …?a=1`), a pattern zsh can't parse, `[ "$a" == b ]`. Others run differently: `for f in $list` loops once, `${arr[0]}` is empty, `echo` turns the `\n` in a JSON string into a line break.

- **Claude**: Beluga writes `~/.beluga/zsh-compat.sh` and sets `CLAUDE_ENV_FILE` to it, for chat runs (a friend's too) and the terminal view. Claude Code runs the file before every Bash command; a command Beluga keeps running past the turn (`BELUGA_KEEP=1`) runs it too. In zsh it turns on `NO_NOMATCH`, `NO_BAD_PATTERN` and `NO_EQUALS`, so those commands go on with the word as typed, as in bash. In bash it does nothing. If you set `CLAUDE_ENV_FILE` yourself, Beluga leaves it alone. The file is `src/agent/runtime/claude/zsh-compat.ts`.
- Only those three: the options also reach the functions your shell defines (nvm, conda, zoxide), which Claude Code loads ahead of each command. `SH_WORD_SPLIT` and `KSH_ARRAYS` would change how they read their own variables (a loop over `$path` saw one folder instead of all of them), and `BSD_ECHO` how they print (`echo "\e[1m"` showed as text). Those habits are left to the instructions.
- **Every agent**: when its commands run in zsh, the instructions say how to write them: quote globs and URLs, compare with `[[ ]]`, loop over arrays (they count from 1), print text with backslashes with `printf`, and never name a variable `path` or `status`. Claude's say its zsh already takes a glob that matches nothing.
- Which shell that is: for Claude, the one Claude Code picks (`CLAUDE_CODE_SHELL`, then `$SHELL` when either is bash or zsh, else zsh before bash, so a fish user's commands run in zsh). For Codex, your login shell as the system has it (it runs `zsh -lc`); Codex has no file it runs before each command, so it gets the instructions only. OpenCode and Copilot follow your login shell too.
- Nothing on Windows: Claude Code runs its commands in Git Bash there.

## The phone

None of this reaches the phone, except the cards for skills your agents propose. Their Keep / Update and Discard (`agentSetup.keepProposal`, `agentSetup.discardProposal`) are `phone` in `src/companion/coverage.ts`, because answering a card fits the phone. Every other `agentSetup.*` method is `mac`.
