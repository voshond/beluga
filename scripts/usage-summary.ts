#!/usr/bin/env -S npx tsx
import path from 'node:path';
import { defaultClaudeDir, defaultCodexDir, isFolder, readUsageRecords, type UsageSources } from '../src/core/usage-files.js';
import { formatUsageSummary, summarizeUsage, usageSummaryJson } from '../src/core/usage-report.js';

const USAGE = `Usage: npx tsx scripts/usage-summary.ts [--claude-dir <folder>] [--codex-dir <folder>] [--json]

  --claude-dir <folder>  Claude Code transcripts (default: $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)
  --codex-dir <folder>   Codex sessions (default: $CODEX_HOME/sessions or ~/.codex/sessions)
  --json                 print the summary as JSON instead of a table

Naming either folder reads only the folders named.
`;

const DIR_FLAGS = ['--claude-dir', '--codex-dir'] as const;

const args = process.argv.slice(2);

const valueOf = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

const fail = (message: string): number => {
  process.stderr.write(`${message}\n\n${USAGE}`);
  return 1;
};

const main = (): number => {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const named = DIR_FLAGS.filter((flag) => args.includes(flag));
  for (const flag of named) {
    const value = valueOf(flag);
    if (!value || value.startsWith('--')) return fail(`${flag} needs a folder`);
    if (!isFolder(path.resolve(value))) return fail(`No folder at ${path.resolve(value)}`);
  }
  const given = (flag: string): string | undefined => {
    const value = valueOf(flag);
    return value ? path.resolve(value) : undefined;
  };
  const sources: UsageSources = named.length
    ? { claudeDir: given('--claude-dir'), codexDir: given('--codex-dir') }
    : { claudeDir: defaultClaudeDir(), codexDir: defaultCodexDir() };
  if (![sources.claudeDir, sources.codexDir].some((dir) => dir && isFolder(dir))) return fail('No Claude Code or Codex logs found');
  const summary = summarizeUsage(readUsageRecords(sources));
  process.stdout.write(args.includes('--json') ? usageSummaryJson(summary) : formatUsageSummary(summary));
  return 0;
};

process.exitCode = main();
