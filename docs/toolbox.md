# Toolbox

Each project can have a Toolbox of named, parameterized commands — "Deploy to arch", "Run migrations", "Start dev server". You run them from the project page or the phone without starting an agent, so they cost no tokens. Agents can list, run and propose tools, and Beluga spots commands that keep repeating and offers to turn them into tools.

## Running tools

Open a project, scroll to the Toolbox section, and click any tool button. It opens in a Terminal tab with live output. Tools with a `{{host}}` param show a dropdown of your `~/.ssh/config` hosts.

The phone lists all tools and can run them, with output shown read-only. Creating, editing and deleting tools is Mac-only.

## Creating and editing tools

Go to Project Settings › Toolbox to create, rename or delete tools.

**Personal tools** (the default) are saved to `~/.beluga/projects.json` and are only on your machine.

**Team tools** are saved to `beluga.json` in the repository. When someone else clones the repo, Beluga asks them to approve each team tool before its first run — the same flow as setup and run scripts.

## Params

Add `{{param}}` placeholders to your command. Beluga substitutes them at run time:

```
ssh {{host}}
rsync -a {{src}} {{dst}}
```

Each param has a **kind**:
- `host` — a dropdown of your `~/.ssh/config` hosts.
- `text` — free text input.

Values are POSIX-shell-quoted on substitution, so they are safe to pass to `sh -c`.

## Agents

Agents in your own runs get three tools in the `beluga_tools` MCP server:

| Tool | What it does |
|------|--------------|
| `tool_list` | Lists all Toolbox tools for the current project |
| `tool_run` | Runs a tool by name, with optional param values |
| `tool_propose` | Proposes a new tool — shows as a "Keep / Discard" card. With `replaces` (a tool's id), it proposes a new version of that tool — an "Update / Discard" card |

`tool_propose` creates a pending proposal in Needs You. You review it on the Mac or phone and choose Keep (saves the tool), Update (changes the existing tool's name, command and params in place; a team tool stays a team tool) or Discard.

### Create or update a tool with an agent

In the Toolbox sheet, **Create with Agent** asks what the tool should do; each tool's ✨ button asks what should change about it. Ask Agent starts a project chat whose agent reads the project, works out the command and calls `tool_propose` (with `replaces` for an update). Nothing is saved until you keep the card it leaves.

## Detection

Beluga watches your agents' Bash commands. When the same command signature appears three or more times in a 14-day window, a Needs You suggestion appears:

- **Make tool** — creates a Toolbox tool immediately.
- **Not this** — dismisses this suggestion and remembers the decision.

The count resets when the window expires. Only your own agents' commands trigger detection.

## Sentinel

Sentinels can run Toolbox tools with the **Run a Toolbox tool** step kind. Set the tool name and optionally override its params. The step fails if the tool exits non-zero.

The paused-by-default **Toolbox scout** recipe runs weekly and proposes new tools based on patterns it finds in your project's agent history.

## Coverage

| Method | Available |
|--------|-----------|
| `toolbox.list` | Mac |
| `toolbox.create` | Mac |
| `toolbox.update` | Mac |
| `toolbox.delete` | Mac |
| `toolbox.run` | Mac + Phone |
| `toolbox.approve` | Mac |
| `toolbox.sshHosts` | Mac |
| `toolbox.dismissSuggestion` | Mac |
| `toolbox.acceptProposal` | Mac |
