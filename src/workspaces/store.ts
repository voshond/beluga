import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProjectsConfig, WorkspaceRecord } from './types.js';

export { belugaHome } from '../core/home.js';
import { belugaHome } from '../core/home.js';

export const DEFAULT_ROOTS = ['Projects', 'projects', 'code', 'Code', 'dev', 'src', 'Developer', 'GitHub', 'repos', 'workspace'].map((d) => path.join(os.homedir(), d));

/** The file's JSON, or `fallback`; one there that can't be read is copied aside first, since the next save replaces it. */
function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    try {
      copyFileSync(file, `${file}.unreadable-${Date.now()}`);
    } catch {
      // Nothing more to keep: the fallback it is.
    }
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Small JSON-file persistence for projects, workspaces and per-workspace chat history. */
export class WorkspaceStore {
  constructor(readonly home: string = belugaHome()) {}

  get workspacesDir(): string {
    return path.join(this.home, 'workspaces');
  }

  /** Smart archives of worktrees: what's kept of each (see archive.ts). */
  get archivesDir(): string {
    return path.join(this.home, 'archives');
  }

  loadConfig(): ProjectsConfig {
    const raw = readJson<Partial<ProjectsConfig>>(path.join(this.home, 'projects.json'), {});
    return { roots: raw.roots ?? DEFAULT_ROOTS, projects: raw.projects ?? [], hidden: raw.hidden ?? [], ...(Array.isArray(raw.removed) && raw.removed.length ? { removed: raw.removed.filter((r): r is string => typeof r === 'string') } : {}), groups: raw.groups ?? [], scripts: raw.scripts ?? {}, approvedScripts: raw.approvedScripts ?? {}, ...(raw.ids && typeof raw.ids === 'object' ? { ids: raw.ids } : {}), ...(Array.isArray(raw.order) ? { order: raw.order.filter((k): k is string => typeof k === 'string') } : {}), ...(raw.toolbox && typeof raw.toolbox === 'object' ? { toolbox: raw.toolbox } : {}), ...(raw.approvedTools && typeof raw.approvedTools === 'object' ? { approvedTools: raw.approvedTools } : {}), ...(raw.toolboxDismissed && typeof raw.toolboxDismissed === 'object' ? { toolboxDismissed: raw.toolboxDismissed } : {}) };
  }

  saveConfig(config: ProjectsConfig): void {
    writeJson(path.join(this.home, 'projects.json'), config);
  }

  loadRecords(): WorkspaceRecord[] {
    return readJson<{ workspaces?: WorkspaceRecord[] }>(path.join(this.home, 'workspaces.json'), {}).workspaces ?? [];
  }

  saveRecords(records: readonly WorkspaceRecord[]): void {
    writeJson(path.join(this.home, 'workspaces.json'), { workspaces: records });
  }

  historyFile(id: string): string {
    return path.join(this.home, 'history', `${id.replace(/[^\w.-]/g, '_')}.json`);
  }

  loadHistory<T>(id: string): T[] {
    return readJson<T[]>(this.historyFile(id), []);
  }

  saveHistory(id: string, items: readonly unknown[]): void {
    writeJson(this.historyFile(id), items);
  }

  /**
   * saveHistory off the main thread's way: the file is written aside, then put in place only if
   * `current()` still says so (a newer save may have come meanwhile).
   */
  async saveHistoryAsync(id: string, items: readonly unknown[], current: () => boolean = () => true): Promise<void> {
    const file = this.historyFile(id);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++asyncWrites}.tmp`;
    await writeFile(tmp, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
    if (!current()) return void (await rm(tmp, { force: true }));
    renameSync(tmp, file);
  }
}

let asyncWrites = 0;
