#!/usr/bin/env -S npx tsx
import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatUsageSummary, recordsFromTranscript, summarizeUsage, usageSummaryJson, type UsageRecord } from '../src/core/usage-report.js';

const USAGE = `Usage: npx tsx scripts/usage-summary.ts [--dir <folder>] [--json]

  --dir <folder>  Claude Code transcripts to read (default: $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)
  --json          print the summary as JSON instead of a table
`;

const args = process.argv.slice(2);

const valueOf = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

const defaultDir = (): string => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

const transcriptsIn = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return transcriptsIn(full);
      return name.endsWith('.jsonl') ? [full] : [];
    });

const projectOf = (root: string, file: string): string => path.relative(root, file).split(path.sep)[0];

const main = (): number => {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const given = valueOf('--dir');
  if (args.includes('--dir') && (!given || given.startsWith('--'))) {
    process.stderr.write(`--dir needs a folder\n\n${USAGE}`);
    return 1;
  }
  const dir = path.resolve(given ?? defaultDir());
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`No transcripts folder at ${dir}\n\n${USAGE}`);
    return 1;
  }
  const records: UsageRecord[] = transcriptsIn(dir).flatMap((file) => recordsFromTranscript(readFileSync(file, 'utf8'), projectOf(dir, file)));
  const summary = summarizeUsage(records);
  process.stdout.write(args.includes('--json') ? usageSummaryJson(summary) : formatUsageSummary(summary));
  return 0;
};

process.exitCode = main();
