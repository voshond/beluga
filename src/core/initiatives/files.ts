import { type Dirent, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { type DecisionNotes, decisionsOf } from './decisions.js';
import { PEOPLE_DIR, type WaitingQuestion, waitingQuestionsOf } from './people.js';
import { type UpdateRecord, UpdatesSchema } from './updates.js';
import { type Artifact, ArtifactsSchema, type EpicStatus, EpicStatusSchema, type EpicTickets, TicketsSchema, type InitiativeTasks, TasksSchema, INITIATIVE_SLUG, type InitiativeConfig, InitiativeConfigSchema, type OutboxDraft, OutboxSchema, type Suggestion, SuggestionsSchema, type TimelineEntry, timelineOf } from './model.js';
import { type Watch, WatchesSchema } from './watches.js';
import { type Risk, RisksSchema } from './risks.js';

import { type Question, QuestionsSchema } from './questions.js';

export const MEMORY_FILES = ['initiative.json', 'brief.md', 'decisions.md', 'questions.json', 'timeline.md', 'people.md', 'status.json', 'tickets.json', 'tasks.json', 'suggestions.json', 'outbox.json', 'watches.json', 'artifacts.json', 'updates.json', 'risks.json', 'success.json'] as const;

const MAX_FILES = 200;
const MAX_READ = 512 * 1024;

export type InitiativeFolder = {
  readonly slug: string;
  readonly folder: string;
  readonly config?: InitiativeConfig;
  readonly brief: string;
  readonly progress?: EpicStatus;
  readonly tickets?: EpicTickets;
  readonly tasks?: InitiativeTasks;
  readonly suggestions: readonly Suggestion[];
  readonly outbox: readonly OutboxDraft[];
  readonly watches: readonly Watch[];
  readonly artifacts: readonly Artifact[];
  readonly updates: readonly UpdateRecord[];
  readonly risks: readonly Risk[];
  readonly timeline: readonly TimelineEntry[];
  readonly decisions?: DecisionNotes;
  readonly questions: readonly Question[];
  readonly waitingQuestions: readonly WaitingQuestion[];
  readonly files: readonly string[];
  readonly trouble?: string;
};

export const folderOf = (root: string, slug: string): string => {
  if (!INITIATIVE_SLUG.test(slug)) throw new Error(`“${slug}” is not an initiative’s folder name`);
  return path.join(root, slug);
};

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

export const writeText = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

const writeJsonFile = (file: string, value: object): void => writeText(file, `${JSON.stringify(value, null, 2)}\n`);

type Parsed<T> = { readonly value?: T; readonly trouble?: string };

const parseJson = <S extends z.ZodTypeAny>(text: string | undefined, schema: S, name: string): Parsed<z.infer<S>> => {
  if (text === undefined) return {};
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) return { value: parsed.data };
    const issue = parsed.error.issues[0];
    return { trouble: `${name}: ${issue ? `${issue.path.join('.') || 'the file'} ${issue.message}` : 'not what it should be'}` };
  } catch (err) {
    return { trouble: `${name} is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
};

export const listSlugs = (root: string): string[] => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && INITIATIVE_SLUG.test(d.name) && d.name !== PEOPLE_DIR)
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
};

export const memoryFiles = (folder: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || out.length >= MAX_FILES) continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next);
      else if (entry.isFile()) out.push(next);
    }
  };
  walk(folder, '');
  const known = new Set<string>(MEMORY_FILES);
  return [...MEMORY_FILES.filter((f) => out.includes(f)), ...out.filter((f) => !known.has(f))];
};

export const readFolder = (root: string, slug: string): InitiativeFolder => {
  const folder = folderOf(root, slug);
  const file = (name: string): string | undefined => readText(path.join(folder, name));
  const config = parseJson(file('initiative.json'), InitiativeConfigSchema, 'initiative.json');
  const status = parseJson(file('status.json'), EpicStatusSchema, 'status.json');
  const tickets = parseJson(file('tickets.json'), TicketsSchema, 'tickets.json');
  const tasks = parseJson(file('tasks.json'), TasksSchema, 'tasks.json');
  const suggestions = parseJson(file('suggestions.json'), SuggestionsSchema, 'suggestions.json');
  const outbox = parseJson(file('outbox.json'), OutboxSchema, 'outbox.json');
  const artifacts = parseJson(file('artifacts.json'), ArtifactsSchema, 'artifacts.json');
  const decisions = decisionsOf(file('decisions.md') ?? '');
  const questions = parseJson(file('questions.json'), QuestionsSchema, 'questions.json');
  const updates = parseJson(file('updates.json'), UpdatesSchema, 'updates.json');
  const watches = parseJson(file('watches.json'), WatchesSchema, 'watches.json');
  const risks = parseJson(file('risks.json'), RisksSchema, 'risks.json');
  const missing = config.value || config.trouble ? undefined : 'initiative.json is missing';
  const troubles = [config.trouble ?? missing, status.trouble, tickets.trouble, tasks.trouble, suggestions.trouble, questions.trouble, outbox.trouble, artifacts.trouble, updates.trouble, watches.trouble, risks.trouble].filter((t): t is string => Boolean(t));
  return {
    slug,
    folder,
    ...(config.value ? { config: config.value } : {}),
    brief: file('brief.md') ?? '',
    ...(status.value ? { progress: status.value } : {}),
    ...(tickets.value ? { tickets: tickets.value } : {}),
    ...(tasks.value ? { tasks: tasks.value } : {}),
    suggestions: suggestions.value ?? [],
    outbox: outbox.value ?? [],
    watches: watches.value ?? [],
    artifacts: artifacts.value ?? [],
    updates: updates.value ?? [],
    risks: risks.value ?? [],
    timeline: timelineOf(file('timeline.md') ?? ''),
    ...(decisions ? { decisions } : {}),
    questions: questions.value ?? [],
    waitingQuestions: waitingQuestionsOf(file('decisions.md') ?? ''),
    files: memoryFiles(folder),
    ...(troubles.length ? { trouble: troubles.join('; ') } : {}),
  };
};

export const writeConfig = (root: string, slug: string, config: InitiativeConfig): void => writeJsonFile(path.join(folderOf(root, slug), 'initiative.json'), config);

export const writeSuggestions = (root: string, slug: string, suggestions: readonly Suggestion[]): void => writeText(path.join(folderOf(root, slug), 'suggestions.json'), `${JSON.stringify(suggestions, null, 2)}\n`);

export const writeTasks = (root: string, slug: string, tasks: InitiativeTasks): void => writeJsonFile(path.join(folderOf(root, slug), 'tasks.json'), tasks);

export const writeOutbox = (root: string, slug: string, outbox: readonly OutboxDraft[]): void => writeText(path.join(folderOf(root, slug), 'outbox.json'), `${JSON.stringify(outbox, null, 2)}\n`);

export const writeUpdates = (root: string, slug: string, updates: readonly UpdateRecord[]): void => writeText(path.join(folderOf(root, slug), 'updates.json'), `${JSON.stringify(updates, null, 2)}\n`);
export const writeQuestions = (root: string, slug: string, questions: readonly Question[]): void => writeJsonFile(path.join(folderOf(root, slug), 'questions.json'), questions);
export const writeWatches = (root: string, slug: string, watches: readonly Watch[]): void => writeText(path.join(folderOf(root, slug), 'watches.json'), `${JSON.stringify(watches, null, 2)}\n`);
export const writeRisks = (root: string, slug: string, risks: readonly Risk[]): void => writeText(path.join(folderOf(root, slug), 'risks.json'), `${JSON.stringify(risks, null, 2)}\n`);

export const writeArtifacts = (root: string, slug: string, artifacts: readonly Artifact[]): void => writeText(path.join(folderOf(root, slug), 'artifacts.json'), `${JSON.stringify(artifacts, null, 2)}\n`);

const safeName = (name: string): string => name.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 120) || 'file';

/** Copies a file into the initiative's artifacts/ as `<id>-<name>`: → its path in the folder. */
export const keepArtifactFile = (root: string, slug: string, id: number, source: string): string => {
  const rel = `artifacts/${id}-${safeName(path.basename(source))}`;
  const target = path.join(folderOf(root, slug), rel);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  return rel;
};

/** An artifact's file in the folder, refused when it would lead outside it. */
export const artifactPath = (root: string, slug: string, rel: string): string => {
  const folder = folderOf(root, slug);
  const file = path.resolve(folder, rel);
  const inside = path.relative(folder, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !existsSync(file)) throw new Error('That artifact’s file is gone');
  return file;
};

/** One line on top of timeline.md's bullets (newest first), as the agent writes them. */
export const addTimeline = (root: string, slug: string, line: string): void => {
  const file = path.join(folderOf(root, slug), 'timeline.md');
  const text = readText(file) ?? '# Timeline\n\nNewest first.\n';
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.startsWith('- '));
  const at = first === -1 ? lines.length : first;
  if (first === -1 && lines.at(-1) === '') lines.pop();
  writeText(file, [...lines.slice(0, at), `- ${line}`, ...lines.slice(at)].join('\n') + (first === -1 ? '\n' : ''));
};

const list = (items: readonly string[], empty: string): string => (items.length ? items.map((i) => `- ${i}`).join('\n') : `- ${empty}`);

export const scaffoldFolder = (root: string, slug: string, config: InitiativeConfig, today: string): void => {
  const folder = folderOf(root, slug);
  mkdirSync(path.join(folder, 'sources'), { recursive: true });
  writeConfig(root, slug, config);
  const put = (name: string, text: string): void => writeText(path.join(folder, name), text);
  put('brief.md', `# ${config.name}\n\n${config.goal || 'The goal is not written down yet.'}\n\n## Where it stands\n\nNothing checked yet. The first check-in fills this in.\n\n## Epics\n\n${list(config.epics, 'none linked yet')}\n`);
  put('decisions.md', `# Decisions\n\n## Open\n\n## Decided\n`);
  put('timeline.md', `# Timeline\n\nNewest first.\n\n- ${today} [created]: initiative created\n`);
  put('people.md', `# People\n\nWho is involved and what they own.\n`);
  put('suggestions.json', '[]\n');
  put('outbox.json', '[]\n');
  put('risks.json', '[]\n');
  put('sources/README.md', `# Sources\n\nSnapshots the check-in keeps: jira.md, slack/, meetings/, docs/, prs.md.\n`);
};

export const readMemoryFile = (root: string, slug: string, rel: string): { readonly name: string; readonly text: string; readonly cut: boolean } => {
  const folder = folderOf(root, slug);
  const file = path.resolve(folder, rel);
  const inside = path.relative(folder, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || inside.split(path.sep).some((p) => p.startsWith('.'))) throw new Error('That file is not in the initiative’s folder');
  const size = statSync(file).size;
  const text = readFileSync(file, 'utf8');
  return { name: inside.split(path.sep).join('/'), text: text.slice(0, MAX_READ), cut: size > MAX_READ };
};
