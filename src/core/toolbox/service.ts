import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectFileName } from '../../workspaces/scripts.js';
import { type Tool, type ToolDraft, type ToolPatch, type ToolboxSig, isToolWorthy, normalizeCommandSig, substituteParams, toolCommandFrom, toolNameFor } from '../../workspaces/toolbox.js';
import type { WorkspaceStore } from '../../workspaces/store.js';
import type { Workbench } from '../workbench.js';
import { toolboxTermId } from '../../shared/terminal-keys.js';
import { readSshHosts } from '../ssh-hosts.js';

const toolCommandHash = (command: string): string => createHash('sha256').update(command.trim()).digest('hex').slice(0, 16);
const sigId = (projectRoot: string, sig: string): string => createHash('sha256').update(`${projectRoot}\0${sig}`).digest('hex').slice(0, 12);

export interface ToolboxDeps {
  readonly store: WorkspaceStore;
  readonly workbench?: Workbench;
}

const SIG_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const SIG_THRESHOLD = 3;

export class ToolboxService {
  constructor(private readonly deps: ToolboxDeps) {}

  private get config() {
    return this.deps.store.loadConfig();
  }

  private save(patch: Parameters<WorkspaceStore['saveConfig']>[0]) {
    this.deps.store.saveConfig(patch);
  }

  listPersonal(projectRoot: string): readonly Tool[] {
    return this.config.toolbox?.[projectRoot] ?? [];
  }

  listTeam(projectRoot: string): readonly Tool[] {
    const name = projectFileName(projectRoot);
    const file = path.join(projectRoot, name);
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { tools?: Tool[] };
      if (Array.isArray(raw.tools)) return raw.tools;
    } catch {
      // no beluga.json or no tools array
    }
    return [];
  }

  list(projectRoot: string): readonly Tool[] {
    return [...this.listPersonal(projectRoot), ...this.listTeam(projectRoot)];
  }

  create(projectRoot: string, draft: ToolDraft): Tool {
    const source = draft.source ?? 'personal';
    const tool: Tool = {
      id: randomUUID(),
      name: draft.name.trim(),
      command: draft.command.trim(),
      ...(draft.params?.length ? { params: draft.params } : {}),
      source,
      ...(draft.createdBy ? { createdBy: draft.createdBy } : {}),
      createdAt: Date.now(),
    };

    if (source === 'team') {
      this.saveToProjectFile(projectRoot, tool, 'add');
    } else {
      const cfg = this.config;
      const existing = cfg.toolbox?.[projectRoot] ?? [];
      this.save({ ...cfg, toolbox: { ...(cfg.toolbox ?? {}), [projectRoot]: [...existing, tool] } });
    }

    return tool;
  }

  update(projectRoot: string, toolId: string, patch: ToolPatch): Tool {
    const personal = this.listPersonal(projectRoot);
    const pIdx = personal.findIndex((t) => t.id === toolId);

    if (pIdx !== -1) {
      const updated: Tool = { ...personal[pIdx]!, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.command !== undefined ? { command: patch.command.trim() } : {}), ...(patch.params !== undefined ? { params: patch.params } : {}), ...(patch.source !== undefined ? { source: patch.source } : {}) };
      if (patch.source === 'team') {
        const cfg = this.config;
        const remaining = personal.filter((t) => t.id !== toolId);
        this.save({ ...cfg, toolbox: { ...(cfg.toolbox ?? {}), [projectRoot]: remaining } });
        this.saveToProjectFile(projectRoot, { ...updated, source: 'team' }, 'add');
      } else {
        const newList = [...personal];
        newList[pIdx] = updated;
        const cfg = this.config;
        this.save({ ...cfg, toolbox: { ...(cfg.toolbox ?? {}), [projectRoot]: newList } });
      }
      return updated;
    }

    const team = this.listTeam(projectRoot);
    const tIdx = team.findIndex((t) => t.id === toolId);
    if (tIdx === -1) throw new Error(`Tool ${toolId} not found`);
    const updated: Tool = { ...team[tIdx]!, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.command !== undefined ? { command: patch.command.trim() } : {}), ...(patch.params !== undefined ? { params: patch.params } : {}), source: patch.source === 'personal' ? 'personal' : 'team' };

    if (patch.source === 'personal') {
      this.saveToProjectFile(projectRoot, team[tIdx]!, 'remove');
      const cfg = this.config;
      const existing = cfg.toolbox?.[projectRoot] ?? [];
      this.save({ ...cfg, toolbox: { ...(cfg.toolbox ?? {}), [projectRoot]: [...existing, { ...updated, source: 'personal' }] } });
    } else {
      this.saveToProjectFile(projectRoot, updated, 'replace');
    }
    return updated;
  }

  delete(projectRoot: string, toolId: string): void {
    const personal = this.listPersonal(projectRoot);
    if (personal.some((t) => t.id === toolId)) {
      const cfg = this.config;
      this.save({ ...cfg, toolbox: { ...(cfg.toolbox ?? {}), [projectRoot]: personal.filter((t) => t.id !== toolId) } });
      return;
    }
    const team = this.listTeam(projectRoot);
    const tool = team.find((t) => t.id === toolId);
    if (tool) this.saveToProjectFile(projectRoot, tool, 'remove');
  }

  isApproved(projectRoot: string, command: string): boolean {
    return Boolean(this.config.approvedTools?.[projectRoot]?.includes(toolCommandHash(command)));
  }

  approve(projectRoot: string, command: string): void {
    const cfg = this.config;
    const list = cfg.approvedTools?.[projectRoot] ?? [];
    const hash = toolCommandHash(command);
    this.save({ ...cfg, approvedTools: { ...(cfg.approvedTools ?? {}), [projectRoot]: [...new Set([...list, hash])].slice(-50) } });
  }

  run(projectRoot: string, projectId: string, toolId: string, params: Readonly<Record<string, string>> = {}): string {
    const tool = this.list(projectRoot).find((t) => t.id === toolId);
    if (!tool) throw new Error(`Tool ${toolId} not found`);

    if (tool.source === 'team' && !this.isApproved(projectRoot, tool.command)) {
      throw new Error('This tool comes from the repository and needs your approval before running. Approve it in the Toolbox settings.');
    }

    const command = substituteParams(tool.command, params);
    const termKey = toolboxTermId(projectId, toolId);

    if (!this.deps.workbench) throw new Error('No workbench available');

    this.deps.workbench.runToolCommand(projectRoot, projectId, termKey, command, tool.name);
    return termKey;
  }

  sshHosts(): Promise<string[]> {
    return readSshHosts();
  }

  // ---- detection

  /** The project a folder belongs to: a worktree's project, else the folder itself. */
  projectRootOf(dir: string): string {
    const record = this.deps.store.loadRecords().find((r) => r.path === dir && r.projectRoot !== dir);
    return record?.projectRoot ?? dir;
  }

  /**
   * Personal tools saved under a worktree's folder (detection used to key them so) move to that
   * worktree's project, where the Toolbox lists them. Returns how many moved.
   */
  adoptStrays(): number {
    const cfg = this.config;
    const toolbox = { ...(cfg.toolbox ?? {}) };
    let moved = 0;
    let changed = false;
    for (const [key, tools] of Object.entries(toolbox)) {
      const root = this.projectRootOf(key);
      if (root === key) continue;
      const kept = toolbox[root] ?? [];
      const fresh = tools.filter((t, i) => !kept.some((k) => k.command === t.command) && tools.findIndex((o) => o.command === t.command) === i);
      toolbox[root] = [...kept, ...fresh];
      delete toolbox[key];
      moved += fresh.length;
      changed = true;
    }
    if (changed) this.save({ ...cfg, toolbox });
    return moved;
  }

  recordBashCommand(cwd: string, command: string): ToolboxSig | undefined {
    const projectRoot = this.projectRootOf(cwd);
    const run = toolCommandFrom(command, cwd, projectRoot, os.homedir());
    if (!isToolWorthy(run)) return undefined;
    const sig = normalizeCommandSig(run);
    if (sig.length < 5) return undefined;
    if (this.list(projectRoot).some((t) => normalizeCommandSig(t.command) === sig)) return undefined;
    const id = sigId(projectRoot, sig);

    const cfg = this.config;
    const dismissed = cfg.toolboxDismissed?.[projectRoot] ?? [];
    if (dismissed.includes(id)) return undefined;

    const sigsFile = path.join(this.deps.store.home, 'toolbox-sigs.json');
    const all = readSigsFile(sigsFile);
    const key = `${projectRoot}\0${id}`;
    const now = Date.now();
    const entry = all[key] ?? { count: 0, firstSeenMs: now, lastSeenMs: now };

    if (now - entry.firstSeenMs > SIG_WINDOW_MS) {
      all[key] = { count: 1, firstSeenMs: now, lastSeenMs: now };
    } else {
      all[key] = { count: entry.count + 1, firstSeenMs: entry.firstSeenMs, lastSeenMs: now };
    }
    writeSigsFile(sigsFile, all);

    const updated = all[key]!;
    if (updated.count >= SIG_THRESHOLD) {
      return { id, projectRoot, command: sig, run, name: toolNameFor(run), count: updated.count, firstSeenMs: updated.firstSeenMs, lastSeenMs: updated.lastSeenMs };
    }
    return undefined;
  }

  dismissSig(projectRoot: string, sigId: string): void {
    const cfg = this.config;
    const existing = cfg.toolboxDismissed?.[projectRoot] ?? [];
    this.save({ ...cfg, toolboxDismissed: { ...(cfg.toolboxDismissed ?? {}), [projectRoot]: [...new Set([...existing, sigId])].slice(-200) } });
  }

  // ---- private helpers

  private saveToProjectFile(projectRoot: string, tool: Tool, action: 'add' | 'remove' | 'replace'): void {
    const name = projectFileName(projectRoot);
    const file = path.join(projectRoot, name);
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      // new file
    }
    const existing: Tool[] = Array.isArray(current.tools) ? (current.tools as Tool[]) : [];
    let updated: Tool[];
    if (action === 'add') {
      updated = [...existing, tool];
    } else if (action === 'remove') {
      updated = existing.filter((t) => t.id !== tool.id);
    } else {
      updated = existing.map((t) => (t.id === tool.id ? tool : t));
    }
    writeFileSync(file, `${JSON.stringify({ ...current, tools: updated }, null, 2)}\n`);
  }
}

function readSigsFile(file: string): Record<string, { count: number; firstSeenMs: number; lastSeenMs: number }> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, { count: number; firstSeenMs: number; lastSeenMs: number }>;
  } catch {
    return {};
  }
}

function writeSigsFile(file: string, data: Record<string, { count: number; firstSeenMs: number; lastSeenMs: number }>): void {
  try {
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // best-effort
  }
}
