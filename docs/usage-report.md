# Usage report

A script that adds up the tokens your agents used, per agent, split by provider and model. It answers "where did my tokens go?" without asking a model anything. (BLG-81)

## Where the numbers come from

Two sources, both read from disk:

- Claude Code transcripts: every `*.jsonl` file under `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` if that isn't set. Those files record the model and the token counts of every reply.
- Codex sessions: every `*.jsonl` file (Codex names them `rollout-*.jsonl`) under `$CODEX_HOME/sessions`, or `~/.codex/sessions` (laid out as `YYYY/MM/DD/`).

Beluga's own `stats.json` isn't used. It keeps tokens per runtime and workspace, but not the model, so it can't split them by model.

OpenCode isn't read yet.

### How Codex tokens are mapped

OpenAI counts cached input inside `input_tokens`. So the report moves it out: Input = `input_tokens` - `cached_input_tokens` - `cache_write_input_tokens`, Cache read = `cached_input_tokens`, Cache write = `cache_write_input_tokens`, Output = `output_tokens`. The total then equals Codex's own `total_tokens`.

- The first `session_meta` line gives the thread: its `cwd` is the agent, its `model_provider` the provider. Each `token_usage_record` becomes one message, with the model of its turn (from `turn_context`). Records of another thread and repeated `response_id`s are skipped or counted once.
- A sub-agent rollout has a `source` with a `subagent` key (main threads have `exec` or `cli`). It is listed as `<cwd> (sub-agents)` with its own model. It also embeds its parent's `session_meta` later in the file; that one is ignored.
- Older rollouts have no `token_usage_record` lines. For those, the running `token_count` totals are diffed (a repeated total adds nothing) and attributed to the latest `turn_context` model.

## Running it

```bash
npx tsx scripts/usage-summary.ts                              # both default folders
npx tsx scripts/usage-summary.ts --claude-dir ./transcripts   # only this Claude Code folder
npx tsx scripts/usage-summary.ts --codex-dir ./sessions       # only this Codex folder
npx tsx scripts/usage-summary.ts --json                       # JSON instead of a table
npx tsx scripts/usage-summary.ts --help                       # the options
```

With no folder flag it reads both defaults. Naming either flag reads only the folders named. It exits with an error if a flag has no value, a folder is missing, or no logs are found at all.

Example output (two worktrees, one of them with sub-agents):

```
Agent usage: 3 agents, 3 models, 4,760 tokens
Total = input + output + cache read + cache write.

/work/alpha  (1,760 tokens)
  Provider   Model              Messages  Input  Output  Cache read  Cache write  Total
  ---------  -----------------  --------  -----  ------  ----------  -----------  -----
  anthropic  claude-opus-5-5           1     10      40       1,000          200  1,250
  anthropic  claude-sonnet-4-6         1      3       7         500            0    510

/work/alpha (sub-agents)  (360 tokens)
  Provider   Model              Messages  Input  Output  Cache read  Cache write  Total
  ---------  -----------------  --------  -----  ------  ----------  -----------  -----
  anthropic  claude-sonnet-4-6         1      2       8         300           50    360

/work/beta  (2,640 tokens)
  Provider   Model            Messages  Input  Output  Cache read  Cache write  Total
  ---------  ---------------  --------  -----  ------  ----------  -----------  -----
  anthropic  claude-opus-5-5         1    100      50       2,000          400  2,550
  openai     gpt-5                   1     30      60           0            0     90

All agents
  Provider   Model              Messages  Input  Output  Cache read  Cache write  Total
  ---------  -----------------  --------  -----  ------  ----------  -----------  -----
  anthropic  claude-opus-5-5           2    110      90       3,000          600  3,800
  anthropic  claude-sonnet-4-6         2      5      15         800           50    870
  openai     gpt-5                     1     30      60           0            0     90
  all                                  5    145     165       3,800          650  4,760
```

## In the app

The right panel's **This workspace › Agent** row opens the same report for one worktree (BLG-85). Click the token count to show the breakdown per provider and model, with this agent and its sub-agents apart. It is read when you open it, and again as the agent works.

- It reads only that worktree's logs: its own folder under the Claude Code transcripts, and the Codex sessions whose folder is the worktree or one inside it.
- The numbers come from the same code as the script (`src/core/usage-report.ts`, through `readFolderUsage` in `src/core/usage-files.ts`). So the panel and the script always agree.
- The breakdown counts like the row does: input + output + cache write, without cache reads (they are nearly free and would drown the rest). So its numbers add up to the row's. Each model's cache reads are still listed on its detail line, and the foot says how many were left out. The script's Total does include them.
- The API method is `workspaces.usageBreakdown`. It is the Mac's only: the phone doesn't show worktree usage yet.

## What an agent is

An agent is a session's working folder. For Beluga that is a worktree, so each task's usage lands on its own line. Sub-agents that a session starts are listed separately as `<folder> (sub-agents)`.

If a line has no folder, the project folder name under the transcripts folder (or the rollout file name for Codex) is used instead.

## How totals are counted

- Claude Code writes one line per content block, so one reply can appear two or three times. Lines with the same message id are counted once, using the largest count of each kind. If the same id shows up under two agents, it goes to the one that sorts first, so file order never matters.
- Total = input + output + cache read + cache write.
- Cache reads are usually most of the total, since every turn re-reads the conversation so far.
- Codex counting is described above.
- Synthetic messages, user messages and lines that aren't JSON are skipped.

## Why it is deterministic

- No model calls and no network. It only reads files.
- Agents and models are sorted the same way every time.
- Numbers use plain comma grouping, not the machine's locale.
- The same files give byte-identical output, in either format.

`tests/usage-report.test.ts` checks this, including that shuffled input gives the same report.
