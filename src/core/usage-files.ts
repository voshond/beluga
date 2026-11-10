import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordsFromCodexRollout, recordsFromTranscript, type UsageRecord } from './usage-report.js';

export type UsageSources = {
  readonly claudeDir?: string;
  readonly codexDir?: string;
};

export const defaultClaudeDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

export const defaultCodexDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

export const isFolder = (dir: string): boolean => statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;

const jsonlIn = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return jsonlIn(full);
      return name.endsWith('.jsonl') ? [full] : [];
    });

const topFolderOf = (root: string, file: string): string => path.relative(root, file).split(path.sep)[0] ?? '';

export const readUsageRecords = (sources: UsageSources): UsageRecord[] => {
  const { claudeDir, codexDir } = sources;
  const claude = claudeDir && isFolder(claudeDir) ? jsonlIn(claudeDir).flatMap((file) => recordsFromTranscript(readFileSync(file, 'utf8'), topFolderOf(claudeDir, file))) : [];
  const codex = codexDir && isFolder(codexDir) ? jsonlIn(codexDir).flatMap((file) => recordsFromCodexRollout(readFileSync(file, 'utf8'), path.basename(file, '.jsonl'))) : [];
  return [...claude, ...codex];
};
