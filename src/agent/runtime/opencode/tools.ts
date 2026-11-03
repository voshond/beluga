import path from 'node:path';
import type { ToolCall, ToolContent } from './acp.js';

/**
 * OpenCode's tools as the tools Beluga already draws and judges (BLG-686): Claude Code's names and
 * input fields, so step titles, the policy (agent/policy.ts) and the approval sheet read the same.
 * `read` → Read { file_path }, `bash` → Bash { command }, `edit` → Edit, an MCP tool
 * `beluga_board_task_get` → mcp__beluga_board__task_get, and so on.
 */

export interface BelugaCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const abs = (cwd: string, p: string | undefined): string | undefined => (p ? path.resolve(cwd, p) : undefined);
const firstPath = (raw: Record<string, unknown>): string | undefined => str(raw.filePath) ?? str(raw.file_path) ?? str(raw.filepath) ?? str(raw.path);

/** The files an apply_patch body touches, in order: added, updated (and where one moves to) or deleted. */
export function patchFiles(patch: string, cwd: string): Array<{ readonly file: string; readonly kind: 'add' | 'update' | 'delete' }> {
  const out: Array<{ file: string; kind: 'add' | 'update' | 'delete' }> = [];
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line.trim()) ?? /^\*\*\* (Move) to: (.+)$/.exec(line.trim());
    if (!m) continue;
    const kind = m[1] === 'Add' ? 'add' : m[1] === 'Delete' ? 'delete' : 'update';
    out.push({ file: path.resolve(cwd, m[2]!.trim()), kind });
  }
  return out;
}

/**
 * Beluga's MCP tool name for an OpenCode one: OpenCode names a server's tool `<server>_<tool>`, so
 * the longest of Beluga's suite names it starts with is the server. Undefined: not one of Beluga's.
 */
export function belugaTool(name: string, suites: readonly string[]): string | undefined {
  const suite = [...suites].sort((a, b) => b.length - a.length).find((s) => name.startsWith(`${s}_`));
  return suite ? `mcp__${suite}__${name.slice(suite.length + 1)}` : undefined;
}

/**
 * One OpenCode tool call as Beluga's: its name (`tool`, the call's first title, OpenCode's tool id)
 * and its input in Claude Code's fields. Several for a patch (one Edit or Write per file).
 */
export function belugaCalls(tool: string, raw: Record<string, unknown>, cwd: string, suites: readonly string[] = []): BelugaCall[] {
  const file = abs(cwd, firstPath(raw));
  switch (tool) {
    case 'read':
      return [{ name: 'Read', input: { file_path: file ?? '', ...(typeof raw.offset === 'number' ? { offset: raw.offset } : {}), ...(typeof raw.limit === 'number' ? { limit: raw.limit } : {}) } }];
    case 'write':
      return [{ name: 'Write', input: { file_path: file ?? '', ...(typeof raw.content === 'string' ? { content: raw.content } : {}) } }];
    case 'edit':
    case 'multiedit':
      return [{ name: 'Edit', input: { file_path: file ?? '', ...(typeof raw.oldString === 'string' ? { old_string: raw.oldString } : {}), ...(typeof raw.newString === 'string' ? { new_string: raw.newString } : {}) } }];
    case 'patch':
    case 'apply_patch': {
      const files = patchFiles(str(raw.patchText) ?? str(raw.patch) ?? str(raw.input) ?? '', cwd);
      return files.length ? files.map((f) => ({ name: f.kind === 'add' ? 'Write' : 'Edit', input: { file_path: f.file } })) : [{ name: 'Edit', input: { file_path: file ?? '' } }];
    }
    case 'bash':
      return [{ name: 'Bash', input: { command: str(raw.command) ?? '', ...(str(raw.description) ? { description: raw.description } : {}), ...(str(raw.workdir) ? { cwd: raw.workdir } : {}) } }];
    case 'glob':
      return [{ name: 'Glob', input: { pattern: str(raw.pattern) ?? '*', path: abs(cwd, str(raw.path)) ?? cwd } }];
    case 'grep':
      return [{ name: 'Grep', input: { pattern: str(raw.pattern) ?? '', path: abs(cwd, str(raw.path)) ?? cwd, ...(str(raw.include) ? { glob: raw.include } : {}) } }];
    case 'list':
      return [{ name: 'LS', input: { path: abs(cwd, str(raw.path)) ?? cwd } }];
    case 'webfetch':
      return [{ name: 'WebFetch', input: { url: str(raw.url) ?? '' } }];
    case 'websearch':
    case 'codesearch':
      return [{ name: 'WebSearch', input: { query: str(raw.query) ?? '' } }];
    case 'task':
      return [{ name: 'Task', input: { description: str(raw.description) ?? '', prompt: str(raw.prompt) ?? '', ...(str(raw.subagent_type) ? { subagent_type: raw.subagent_type } : {}) } }];
    case 'todowrite':
    case 'todoread':
      return [{ name: 'TodoWrite', input: { todos: Array.isArray(raw.todos) ? raw.todos.map((t: { content?: unknown; status?: unknown }) => ({ content: String(t?.content ?? ''), status: String(t?.status ?? 'pending'), activeForm: String(t?.content ?? '') })) : [] } }];
    case 'skill':
      return [{ name: 'Skill', input: { skill: str(raw.name) ?? '' } }];
    case 'lsp':
      return [{ name: 'Read', input: { file_path: file ?? '' } }];
    default: {
      const mcp = belugaTool(tool, suites);
      return [{ name: mcp ?? `mcp__opencode__${tool}`, input: raw }];
    }
  }
}

/** What a finished call gave back, as a tool_result's content (its text, or the files' diffs). */
export function resultText(call: Pick<ToolCall, 'content' | 'rawOutput'>): string {
  const parts = (call.content ?? []).flatMap((c: ToolContent) => {
    if (c.type === 'content' && 'content' in c) return c.content.text ? [c.content.text] : [];
    if (c.type === 'diff' && 'path' in c) return [`${c.path}\n${c.newText}`];
    return [];
  });
  if (parts.length) return parts.join('\n');
  const out = call.rawOutput as { output?: unknown } | undefined;
  return typeof out?.output === 'string' ? out.output : '';
}

/** The files an edit wrote (its diffs, else where it says it is): for onFileTouched. */
export function touchedFiles(call: Pick<ToolCall, 'content' | 'locations'>, cwd: string): string[] {
  const diffs = (call.content ?? []).flatMap((c) => (c.type === 'diff' && 'path' in c ? [path.resolve(cwd, c.path)] : []));
  return diffs.length ? diffs : (call.locations ?? []).map((l) => path.resolve(cwd, l.path));
}
