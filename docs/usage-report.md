# Usage report

A script that adds up the tokens your agents used, per agent, split by provider and model. It answers "where did my tokens go?" without asking a model anything. (BLG-81)

## Where the numbers come from

It reads Claude Code's own transcripts: every `*.jsonl` file under `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` if that isn't set. Those files record the model and the token counts of every reply.

Beluga's own `stats.json` isn't used. It keeps tokens per runtime and workspace, but not the model, so it can't split them by model.

Other runtimes (Codex, OpenCode) aren't read yet.

## Running it

```bash
npx tsx scripts/usage-summary.ts                    # the default transcripts folder
npx tsx scripts/usage-summary.ts --dir ./transcripts  # another folder
npx tsx scripts/usage-summary.ts --json             # JSON instead of a table
npx tsx scripts/usage-summary.ts --help             # the options
```

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

## What an agent is

An agent is a session's working folder. For Beluga that is a worktree, so each task's usage lands on its own line. Sub-agents that a session starts are listed separately as `<folder> (sub-agents)`.

If a line has no folder, the project folder name under the transcripts folder is used instead.

## How totals are counted

- Claude Code writes one line per content block, so one reply can appear two or three times. Lines with the same message id are counted once, using the largest count of each kind. If the same id shows up under two agents, it goes to the one that sorts first, so file order never matters.
- Total = input + output + cache read + cache write.
- Cache reads are usually most of the total, since every turn re-reads the conversation so far.
- Synthetic messages, user messages and lines that aren't JSON are skipped.

## Why it is deterministic

- No model calls and no network. It only reads files.
- Agents and models are sorted the same way every time.
- Numbers use plain comma grouping, not the machine's locale.
- The same files give byte-identical output, in either format.

`tests/usage-report.test.ts` checks this, including that shuffled input gives the same report.
