# Skills & instructions

Settings › Skills & instructions controls what your own agents know beyond the request in front of them. It has four parts. Everything on this page applies to runs you start on this computer. A friend's or a guest's run never gets any of it.

## About this machine

A note about this computer, with one switch for all of it. When the switch is on, Beluga adds the note to every run you start: Claude gets it in its system prompt, Codex in its developer instructions, and OpenCode in its instructions file. It sits right after the room instructions, inside `<machine_context>`.

Use it for what is true of the machine rather than of a project. For example: the repos are checked out here, there are SSH keys to the NAS, and the agent may use them to check results or deploy. Say where access is, never what it is: the note is saved in `~/.beluga/settings.json` (`machineNote`, `machineNoteOn`), so don't put a password or a key in it.

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

## Global AGENTS.md

The editor writes `~/.agents/AGENTS.md`. Below it, two rows show whether `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` point at that file. Link makes them point at it:

- When there's no shared file yet and the agent has a file of its own, that file becomes the shared one. Its old path then links to it.
- Otherwise, a file of its own, or a link to somewhere else, is renamed to `….beluga-backup-<time>` next to it, and the toast says where it went.

On Windows, linking a file needs an administrator, so Beluga copies the file instead. The row then shows a file of its own.

## Built-in instructions

This is a read-only list of each piece Beluga adds to a run's instructions, in the order it adds them. Each piece shows when it is added (every run, worktree runs, a main folder, the terminal view, …), the file it comes from, and its text. Pieces that are written for each run (a task's brief, a plan's) show only their source. To change a piece, edit that source and open a pull request.

The list and the real instructions come from the same code, `INSTRUCTION_PIECES` in `src/agent/run-instructions.ts`, so they can't drift apart. That code is the hook: `runInstructions` joins the pieces for every run. Claude receives the result through `systemPrompt.append`, Codex through `developerInstructions`, and OpenCode through its instructions file. Your own `CLAUDE.md`, `AGENTS.md` and skills don't pass through Beluga: each agent loads them itself on your own runs.

## Zsh

Agents run their commands in your login shell, but they write them for bash. On zsh that used to stop whole commands: an unquoted glob that matches nothing (`--include=*.ts`), `[ "$a" == b ]`, `for f in $list`, `${arr[0]}`.

- Claude: Beluga writes `~/.beluga/zsh-compat.sh` and sets `CLAUDE_ENV_FILE` to it, for chat runs and the terminal view. Claude Code runs the file before every Bash command. In zsh it turns on `NO_NOMATCH`, `NO_BAD_PATTERN`, `NO_EQUALS`, `SH_WORD_SPLIT`, `KSH_ARRAYS` and `BSD_ECHO`, so these commands work as they do in bash. In bash it does nothing. If you set `CLAUDE_ENV_FILE` yourself, Beluga leaves it alone. The file is `src/agent/runtime/claude/zsh-compat.ts`.
- Every agent (Claude, Codex, OpenCode): when your login shell is zsh, the instructions include the **Your shell is zsh** piece, which says how to write commands for it.

## The phone

None of this reaches the phone. All `agentSetup.*` methods are `mac` in `src/companion/coverage.ts`.
