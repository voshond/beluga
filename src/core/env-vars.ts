/**
 * Environment variables you set for your shells, setup and run commands, and your Claude:
 * your own (everywhere) and per project (over yours). A project's main folder .env (and
 * .env.local) loads by default under its own, so you rarely set anything by hand (BLG-369). They're kept in ~/.beluga/env.json,
 * readable only by you, and never leave this computer: screens get their names, and the
 * values only when one asks (Settings), never in the shared state or anything sent to the room.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ENV_KEY, type EnvKeys, type EnvVar, MAX_ENV_VALUE, MAX_ENV_VARS, envProblems, envRecord, importEnv, mergeEnv, parseEnvText } from '../shared/env-vars.js';
import { ENDPOINT_ID, endpointIdFor } from '../shared/local-endpoints.js';
import type { Project } from '../workspaces/types.js';
import { belugaHome } from './home.js';
import type { Store } from './store.js';

/** One local or bring-your-own endpoint (see shared/local-endpoints.ts). */
export const Endpoint = z.object({
  id: z.string().regex(ENDPOINT_ID),
  label: z.string().min(1).max(40),
  baseUrl: z.string().url().max(500).refine((u) => /^https?:\/\//.test(u), 'Use an http:// or https:// address'),
  key: z.string().max(4000).optional(),
  models: z.array(z.string().min(1).max(40)).max(20).default([]),
});
export type Endpoint = z.infer<typeof Endpoint>;
const MAX_ENDPOINTS = 12;

const Vars = z.record(z.string().regex(ENV_KEY), z.string().max(MAX_ENV_VALUE));

/** What env.json holds. */
export const EnvFile = z.object({
  global: Vars.default({}),
  /** Your own Claude reads and changes .env files without asking, in every project. */
  claudeDotenv: z.boolean().default(false),
  /**
   * By project folder. `dotenv`: load the main folder's .env (unset: yes; true: you switched it on
   * yourself, before it was the default, so your Claude gets it too). `claudeDotenv`: your own Claude
   * reads and changes its .env files without asking.
   */
  projects: z.record(z.string(), z.object({ vars: Vars.default({}), dotenv: z.boolean().optional(), claudeDotenv: z.boolean().default(false), newKeysBack: z.boolean().optional() })).default({}),
  /**
   * Anthropic-compatible endpoints your Claude Code can run against (BLG-449): kept here with your
   * other secrets, never published. Screens get them without the key (local-endpoints.ts).
   */
  endpoints: z.array(Endpoint).max(MAX_ENDPOINTS).default([]),
  /** 2: `dotenv` unset means on. Files without it said false for "never switched on". */
  v: z.number().optional(),
});
export type EnvFile = z.infer<typeof EnvFile>;

const EMPTY: EnvFile = { global: {}, claudeDotenv: false, projects: {}, endpoints: [], v: 2 };

/** A file from before .env loaded by default: its "off" was only never switched on, so it's the default now. */
function upgrade(file: EnvFile): EnvFile {
  if (file.v === 2) return file;
  const projects = Object.fromEntries(Object.entries(file.projects).map(([root, p]) => [root, p.dotenv === false ? { vars: p.vars, claudeDotenv: p.claudeDotenv } : p]));
  return { ...file, projects, v: 2 };
}

/** Whether a project loads its main folder's .env. */
const loadsDotenv = (p: { dotenv?: boolean } | undefined): boolean => p?.dotenv !== false;

/** The .env files read from a folder, later ones winning (as Next.js, Vite and the like read them). */
export const DOTENV_FILES = ['.env', '.env.local'] as const;
/** A .env bigger than this isn't read. */
const MAX_DOTENV_BYTES = 256 * 1024;

export const envPath = (): string => path.join(belugaHome(), 'env.json');

export function loadEnvFile(file: string = envPath()): EnvFile {
  return readEnvFile(file) ?? EMPTY;
}

/** env.json as it is: none there is empty; one that doesn't read (half-written, mistyped by hand) is undefined. */
function readEnvFile(file: string): EnvFile | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return EMPTY;
  }
  try {
    const parsed = EnvFile.safeParse(JSON.parse(text));
    return parsed.success ? upgrade(parsed.data) : undefined;
  } catch {
    return undefined;
  }
}

/** When env.json last changed (its time and size), or none. */
function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}

/** Save atomically, readable only by you. */
export function saveEnvFile(data: EnvFile, file: string = envPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The variables in one file (none when it isn't there, or it's too big). */
function readOne(file: string): Record<string, string> {
  try {
    if (statSync(file).size > MAX_DOTENV_BYTES) return {};
    return envRecord(parseEnvText(readFileSync(file, 'utf8')).vars);
  } catch {
    return {};
  }
}

/** The variables in a folder's .env and .env.local (.env.local wins). */
export function readDotenv(dir: string): Record<string, string> {
  return mergeEnv(...DOTENV_FILES.map((f) => readOne(path.join(dir, f))));
}

/** Which of the .env files a folder has. */
const dotenvFilesIn = (dir: string): string[] => DOTENV_FILES.filter((f) => {
  try {
    return statSync(path.join(dir, f)).isFile();
  } catch {
    return false;
  }
});

/** One place's variables, for the Settings editor. */
export interface EnvScope {
  readonly vars: readonly EnvVar[];
  /** A key a worktree adds goes into the main folder's .env on its own (projects only; on unless switched off). */
  readonly newKeysBack?: boolean;
  /** Load the main folder's .env (projects only; on unless you switched it off). */
  readonly dotenv: boolean;
  /** Names in the project's .env right now (shown so you know what it adds). */
  readonly dotenvKeys: readonly string[];
  /** The main folder's .env variables, with their values, for the editor beside the project's own (projects only). */
  readonly dotenvVars?: readonly EnvVar[];
  /** The .env files they come from (".env", ".env.local"). */
  readonly dotenvFiles?: readonly string[];
  /** Your own Claude reads .env files here without asking (no project: in every project). */
  readonly claudeDotenv: boolean;
  /** Yours only: names a project's variables or its .env win over, and which (so an edit here isn't a surprise). */
  readonly overridden?: Readonly<Record<string, readonly string[]>>;
}

/** Whether your own Claude may read a folder's .env files without asking you (see agent-host.ts). */
export interface DotenvAccess {
  readonly allowed: (dir?: string) => boolean;
  /** The project's name, when the folder is in one of yours ("Always for <project>"). */
  readonly project: (dir?: string) => string | undefined;
  /** You said always: for this folder's project, or everywhere. */
  readonly allow: (dir: string | undefined, scope: 'project' | 'everywhere') => void;
}

/** Where something runs: a workspace, a project, or just a folder. */
export interface EnvPlace {
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly dir?: string;
}

export interface EnvVarsDeps {
  readonly store: Store;
  readonly file?: string;
  /** Your variables changed: terminals already running still have the old ones (see Workbench.envChanged). */
  readonly onChange?: () => void;
}

const inside = (dir: string, root: string): boolean => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export class EnvVars {
  private kept: EnvFile;
  /** env.json's time and size when it was read or written here. */
  private stamp: string;

  constructor(private readonly deps: EnvVarsDeps) {
    this.stamp = stampOf(this.file);
    this.kept = loadEnvFile(this.file);
    this.publish();
  }

  private get file(): string {
    return this.deps.file ?? envPath();
  }

  /**
   * The variables, read again when env.json changed on disk (edited by hand, or by another Beluga),
   * so a run uses them at once without a restart (BLG-302). A file that doesn't read keeps the last good ones.
   */
  private get data(): EnvFile {
    const now = stampOf(this.file);
    if (now !== this.stamp) {
      this.stamp = now;
      const fresh = readEnvFile(this.file);
      if (fresh) {
        this.kept = fresh;
        this.publish();
        // Told after this read: the terminals' check reads the variables again.
        queueMicrotask(() => this.deps.onChange?.());
      }
    }
    return this.kept;
  }

  private set data(next: EnvFile) {
    this.kept = next;
  }

  /** Write the variables, and remember the file as written (it isn't read back as a change). */
  private save(): void {
    saveEnvFile(this.kept, this.deps.file);
    this.stamp = stampOf(this.file);
  }

  private get projects(): readonly Project[] {
    return this.deps.store.getState().projects.filter((p) => p.root);
  }

  private project(id: string | undefined): Project | undefined {
    return id ? this.projects.find((p) => p.id === id) : undefined;
  }

  /** Tell screens the names (never the values). */
  private publish(): void {
    const projects = Object.fromEntries(Object.entries(this.kept.projects).map(([root, p]) => [root, { keys: Object.keys(p.vars), dotenv: loadsDotenv(p) }]));
    const keys: EnvKeys = { global: Object.keys(this.kept.global), projects };
    this.deps.store.dispatch({ type: 'env_keys', keys });
  }

  /** Your variables (no project), or a project's. */
  get(projectId?: string): EnvScope {
    if (!projectId) return { vars: toRows(this.data.global), dotenv: false, dotenvKeys: [], claudeDotenv: this.data.claudeDotenv, overridden: this.overridden() };
    const project = this.project(projectId);
    const saved = project ? this.data.projects[project.root] : undefined;
    const dotenvVars = project ? readDotenv(project.root) : {};
    return {
      vars: toRows(saved?.vars ?? {}),
      dotenv: loadsDotenv(saved),
      dotenvKeys: Object.keys(dotenvVars),
      dotenvVars: toRows(dotenvVars),
      dotenvFiles: project ? dotenvFilesIn(project.root) : [],
      claudeDotenv: saved?.claudeDotenv ?? false,
      newKeysBack: saved?.newKeysBack !== false,
    };
  }

  /** Let your own Claude read .env files without asking (or ask again): in a project, or with none, everywhere. */
  setClaudeDotenv(projectId: string | undefined, on: boolean): void {
    if (!projectId) this.data = { ...this.data, claudeDotenv: on };
    else {
      const project = this.project(projectId);
      if (!project) throw new Error('That project is gone');
      this.data = { ...this.data, projects: this.withProject(project.root, { claudeDotenv: on }) };
    }
    this.save();
  }

  /** The projects with one changed (and dropped when there's nothing left to keep). */
  private withProject(root: string, change: Partial<EnvFile['projects'][string]>): EnvFile['projects'] {
    const { [root]: before, ...others } = this.data.projects;
    const next: EnvFile['projects'][string] = { vars: {}, claudeDotenv: false, ...before, ...change };
    // Back on (the default): nothing to keep for it.
    if (next.dotenv === undefined || ('dotenv' in change && change.dotenv === undefined)) delete next.dotenv;
    if (next.newKeysBack !== false) delete next.newKeysBack;
    return Object.keys(next.vars).length || next.dotenv !== undefined || next.claudeDotenv || next.newKeysBack === false ? { ...others, [root]: next } : others;
  }

  readonly dotenvAccess: DotenvAccess = {
    allowed: (dir) => this.data.claudeDotenv || Boolean(dir && this.data.projects[this.placeOf({ dir }).project?.root ?? '']?.claudeDotenv),
    project: (dir) => (dir ? this.placeOf({ dir }).project?.name : undefined),
    allow: (dir, scope) => {
      const project = dir ? this.placeOf({ dir }).project : undefined;
      if (scope === 'everywhere') this.data = { ...this.data, claudeDotenv: true };
      else if (project) this.data = { ...this.data, projects: this.withProject(project.root, { claudeDotenv: true }) };
      else return;
      this.save();
    },
  };

  /**
   * Replace your variables (no project) or a project's, and whether it loads its .env (switched
   * off is kept; on is the default again, so it isn't). Rows without a name are skipped; a bad
   * name or one used twice refuses the whole change.
   */
  set(projectId: string | undefined, rows: readonly EnvVar[], dotenv?: boolean): void {
    const filled = rows.filter((r) => r.key || r.value);
    const problem = [...envProblems(filled).values()][0];
    if (problem) throw new Error(problem);
    if (filled.length > MAX_ENV_VARS) throw new Error(`Up to ${MAX_ENV_VARS} variables`);
    const vars = envRecord(filled);
    if (!projectId) {
      this.data = { ...this.data, global: vars };
    } else {
      const project = this.project(projectId);
      if (!project) throw new Error('That project is gone');
      const before = this.data.projects[project.root]?.dotenv;
      // Switching it back on keeps a "true" you set before it was the default (it gives your Claude the .env too).
      const nextDotenv = dotenv === undefined ? before : dotenv ? (before === true ? true : undefined) : false;
      this.data = { ...this.data, projects: this.withProject(project.root, { vars, dotenv: nextDotenv }) };
    }
    this.save();
    this.publish();
    this.deps.onChange?.();
  }

  /**
   * Copy the main folder's .env values into the project's own (BLG-369), so they're kept in Beluga
   * even if the file goes. A value you set here already stays. → how many were added.
   */
  importDotenv(projectId: string): number {
    const project = this.project(projectId);
    if (!project) throw new Error('That project is gone');
    const own = this.get(projectId).vars;
    const known = new Set(own.map((v) => v.key));
    const incoming = toRows(readDotenv(project.root)).filter((v) => !known.has(v.key));
    if (!incoming.length) return 0;
    this.set(projectId, [...own, ...incoming]);
    return incoming.length;
  }

  /** Whether keys a worktree adds go into the project's main .env on its own (by project id; on by default). */
  newKeysBack(projectId: string): boolean {
    const project = this.project(projectId);
    return project ? this.data.projects[project.root]?.newKeysBack !== false : false;
  }

  setNewKeysBack(projectId: string, on: boolean): void {
    const project = this.project(projectId);
    if (!project) throw new Error('That project is gone');
    this.data = { ...this.data, projects: this.withProject(project.root, { newKeysBack: on }) };
    this.save();
  }

  /** A project's folder moved (Move Project): its own variables and choices go with it. */
  moveProject(from: string, to: string): void {
    const own = this.data.projects[from];
    if (!own) return;
    const { [from]: _gone, ...rest } = this.data.projects;
    this.data = { ...this.data, projects: { ...rest, [to]: own } };
    this.save();
  }

  /** Your endpoints, keys and all: for runs on this Mac only (never a screen: see local-endpoints.ts). */
  endpoints(): readonly Endpoint[] {
    return this.data.endpoints;
  }

  /**
   * Add or change an endpoint. `key`: undefined keeps the one it has, '' removes it. A new one
   * (no id) gets an id from its label. → its id.
   */
  saveEndpoint(change: { readonly id?: string; readonly label: string; readonly baseUrl: string; readonly key?: string; readonly models?: readonly string[] }): string {
    const list = this.data.endpoints;
    const before = change.id ? list.find((e) => e.id === change.id) : undefined;
    if (change.id && !before) throw new Error('That endpoint is gone');
    const id = before?.id ?? endpointIdFor(change.label, list.map((e) => e.id));
    const key = change.key === undefined ? before?.key : change.key || undefined;
    const models = [...new Set((change.models ?? before?.models ?? []).map((m) => m.trim()).filter(Boolean))];
    const parsed = Endpoint.safeParse({ id, label: change.label.trim(), baseUrl: change.baseUrl.trim().replace(/\/+$/, ''), ...(key ? { key } : {}), models });
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'That endpoint doesn’t look right');
    if (!before && list.length >= MAX_ENDPOINTS) throw new Error(`Up to ${MAX_ENDPOINTS} endpoints`);
    this.data = { ...this.data, endpoints: before ? list.map((e) => (e.id === id ? parsed.data : e)) : [...list, parsed.data] };
    this.save();
    return id;
  }

  removeEndpoint(id: string): void {
    this.data = { ...this.data, endpoints: this.data.endpoints.filter((e) => e.id !== id) };
    this.save();
  }

  /** Set these in a project's own variables (same name: replaced), e.g. a worktree's .env changes (Save in Beluga). → how many. */
  merge(projectId: string, vars: Readonly<Record<string, string>>): number {
    const incoming = toRows(vars);
    if (incoming.length) this.set(projectId, importEnv(this.get(projectId).vars, incoming));
    return incoming.length;
  }

  /** Set (or with an empty value, remove) one of your variables, or one of a project's. */
  setOne(projectId: string | undefined, key: string, value: string | undefined): void {
    const rows = this.get(projectId).vars.filter((r) => r.key !== key);
    this.set(projectId, value === undefined ? rows : [...rows, { key, value }]);
  }

  /** The project something runs in: the workspace's, the one named, or the one whose folder holds `dir`. */
  private placeOf(where: EnvPlace): { project?: Project; dir?: string } {
    const projects = this.projects;
    if (where.workspaceId) {
      for (const p of projects) {
        const ws = p.workspaces.find((w) => w.id === where.workspaceId);
        if (ws) return { project: p, dir: ws.path };
      }
    }
    const named = this.project(where.projectId);
    if (named) return { project: named, dir: where.dir ?? named.root };
    const dir = where.dir ? path.resolve(where.dir) : undefined;
    if (!dir) return {};
    const project = projects.find((p) => inside(dir, p.root) || p.workspaces.some((w) => inside(dir, w.path)));
    return { project, dir };
  }

  /**
   * The variables for something starting there: yours, then the project's .env (unless you
   * switched it off; the workspace's own copy over the main folder's), then the project's own.
   * For your own Claude (`claude`) the .env counts only where it may read .env files without
   * asking (or you switched it on yourself before it was the default): loading it by default
   * mustn't hand Claude what it would otherwise ask you for.
   */
  envFor(where: EnvPlace = {}, opts: { readonly claude?: boolean } = {}): Record<string, string> {
    const { project, dir } = this.placeOf(where);
    const own = project ? this.data.projects[project.root] : undefined;
    const allowed = !opts.claude || own?.dotenv === true || this.data.claudeDotenv || Boolean(own?.claudeDotenv);
    const dotenv = project && loadsDotenv(own) && allowed ? { ...readDotenv(project.root), ...(dir && dir !== project.root ? readDotenv(dir) : {}) } : undefined;
    return mergeEnv(this.data.global, dotenv, own?.vars);
  }

  /**
   * The variables a database view there can use: as envFor, but the project's .env always counts.
   * They go only to the database's own tools on this Mac (psql), never to Claude or the room.
   */
  /** viewEnv for one of your projects (by id), or with none just yours. */
  viewEnvOf(projectId?: string): { vars: Record<string, string>; where: string } {
    const project = this.project(projectId);
    if (projectId && !project) throw new Error('That project is gone');
    return project ? this.viewEnv(project.root) : { vars: { ...this.data.global }, where: 'your variables (Settings › Environment)' };
  }

  viewEnv(dir?: string): { vars: Record<string, string>; where: string } {
    const { project, dir: at } = this.placeOf({ dir });
    const own = project ? this.data.projects[project.root] : undefined;
    const dotenv = { ...(project ? readDotenv(project.root) : {}), ...(at && at !== project?.root ? readDotenv(at) : {}) };
    const where = project ? `your variables, ${project.name}’s variables (Settings › Environment) and its .env` : 'your variables (Settings › Environment); this folder isn’t in one of your projects';
    return { vars: mergeEnv(this.data.global, dotenv, own?.vars), where };
  }

  /**
   * Your variables that something else wins over, by name: a project's own variables, or its
   * .env when it's loaded. Changing yours there changes nothing (Settings says so).
   */
  private overridden(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const p of this.projects) {
      const own = this.data.projects[p.root];
      if (!own) continue;
      const dotenv = loadsDotenv(own) ? Object.keys(readDotenv(p.root)) : [];
      for (const key of Object.keys(this.data.global)) {
        const by = key in own.vars ? `${p.name}’s variables` : dotenv.includes(key) ? `${p.name}’s .env` : undefined;
        if (by) (out[key] ??= []).push(by);
      }
    }
    return out;
  }
}

const toRows = (vars: Readonly<Record<string, string>>): EnvVar[] => Object.entries(vars).map(([key, value]) => ({ key, value }));
