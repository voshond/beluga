import { readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SUB_AGENTS, recordsFromCodexRollout, recordsFromTranscript, summarizeUsage, type UsageRecord, type UsageSummary } from './usage-report.js';

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

const jsonlUnder = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const nested = await Promise.all(
    sorted.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return jsonlUnder(full);
      return entry.name.endsWith('.jsonl') ? [full] : [];
    }),
  );
  return nested.flat();
};

export const claudeFolderOf = (claudeDir: string, cwd: string): string => path.join(claudeDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));

const isInside = (folder: string, agent: string): boolean => agent === folder || agent.startsWith(`${folder}/`) || agent.startsWith(`${folder} `);

export const readFolderUsage = async (folder: string, sources: UsageSources): Promise<UsageSummary> => {
  const { claudeDir, codexDir } = sources;
  const claudeFiles = claudeDir ? await jsonlUnder(claudeFolderOf(claudeDir, folder)) : [];
  const codexFiles = codexDir ? await jsonlUnder(codexDir) : [];
  const needle = JSON.stringify(folder).slice(0, -1);
  const claude = await Promise.all(claudeFiles.map(async (file) => recordsFromTranscript(await readFile(file, 'utf8'), folder)));
  const codex = await Promise.all(
    codexFiles.map(async (file) => {
      const text = await readFile(file, 'utf8');
      return text.includes(needle) ? recordsFromCodexRollout(text, path.basename(file, '.jsonl')) : [];
    }),
  );
  const records = [...claude.flat(), ...codex.flat()]
    .filter((r) => isInside(folder, r.agent))
    .map((r) => ({ ...r, agent: r.agent.endsWith(SUB_AGENTS) ? `${folder}${SUB_AGENTS}` : folder }));
  return summarizeUsage(records);
};

export const readUsageRecords =(sources: UsageSources): UsageRecord[] => {
  const { claudeDir, codexDir } = sources;
  const claude = claudeDir && isFolder(claudeDir) ? jsonlIn(claudeDir).flatMap((file) => recordsFromTranscript(readFileSync(file, 'utf8'), topFolderOf(claudeDir, file))) : [];
  const codex = codexDir && isFolder(codexDir) ? jsonlIn(codexDir).flatMap((file) => recordsFromCodexRollout(readFileSync(file, 'utf8'), path.basename(file, '.jsonl'))) : [];
  return [...claude, ...codex];
};
