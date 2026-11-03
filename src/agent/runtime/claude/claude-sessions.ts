import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { open, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { type Conversation, type ConversationSummary, type TranscriptMessage, transcriptToTurns, typedText } from '../../transcript.js';
import { isUnder } from '../../../shared/path-inside.js';

/**
 * Finding the Claude Code conversations that ran in a folder (a worktree made by Conductor or
 * by Claude Code itself). Claude Code keeps each one in
 * ~/.claude/projects/<the folder, every non-alphanumeric character as "->/<session>.jsonl.
 */

/** Where Claude Code keeps its data (CLAUDE_CONFIG_DIR, else ~/.claude). */
export const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** The folder name Claude Code files a working directory's sessions under. */
export const encodeProjectDir = (dir: string): string => dir.replace(/[^a-zA-Z0-9]/g, '-');

/** macOS top-level folders that are symlinks into /private. */
const PRIVATE_LINKS = ['/tmp', '/var', '/etc'];

const realOf = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Every way the same folder may be spelled: as given, with symlinks resolved, and with or
 * without macOS's /private prefix (/tmp/x and /private/tmp/x are one folder).
 */
export function pathVariants(dir: string): string[] {
  const out = new Set([path.resolve(dir), realOf(dir)]);
  for (const v of [...out]) {
    for (const top of PRIVATE_LINKS) {
      const priv = `/private${top}`;
      if (v === priv || v.startsWith(`${priv}/`)) out.add(v.slice('/private'.length));
      else if (v === top || v.startsWith(`${top}/`)) out.add(`/private${v}`);
    }
  }
  return [...out];
}

/** Whether two paths name the same folder (symlinks and /private resolved). */
export function samePath(a: string, b: string): boolean {
  const theirs = new Set(pathVariants(b));
  return pathVariants(a).some((v) => theirs.has(v));
}

const WRAPPERS = /<(system_instruction|system-instruction)>[\s\S]*?<\/\1>/g;
const MAX_TITLE = 80;

/** A session's title as people read it: theirs, Claude Code's, or the first thing typed. */
export function sessionTitle(info: { customTitle?: string; summary?: string; firstPrompt?: string }): string {
  const raw = info.customTitle || info.summary || info.firstPrompt || 'Untitled conversation';
  const clean = raw.replace(WRAPPERS, ' ').replace(/\s+/g, ' ').trim() || 'Untitled conversation';
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1).trimEnd()}…` : clean;
}

type Info = { sessionId: string; summary: string; lastModified: number; customTitle?: string; firstPrompt?: string; cwd?: string; createdAt?: number };
const summaryOf = (s: Info): ConversationSummary => ({ sessionId: s.sessionId, title: sessionTitle(s), lastModified: s.lastModified, ...(s.createdAt ? { createdAt: s.createdAt } : {}) });

/** Transcript files filed under one spelling of a folder. */
function sessionFilesIn(dir: string): string[] {
  return transcriptsIn(path.join(claudeConfigDir(), 'projects', encodeProjectDir(dir)));
}

/** The transcript files in one of Claude Code's project folders. */
function transcriptsIn(folder: string): string[] {
  if (!existsSync(folder)) return [];
  try {
    return readdirSync(folder)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(folder, f));
  } catch {
    return [];
  }
}

const PEEK = 256 * 1024;

/** The start and end of a (possibly huge) transcript: enough for its folder, first prompt and title. */
async function peek(file: string, size: number): Promise<string[]> {
  const fh = await open(file, 'r');
  try {
    const read = async (at: number, len: number): Promise<string> => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, at);
      return buf.subarray(0, bytesRead).toString('utf8');
    };
    if (size <= PEEK * 2) return (await read(0, size)).split('\n');
    // Drop the partial lines where the two pieces were cut.
    return [...(await read(0, PEEK)).split('\n').slice(0, -1), ...(await read(size - PEEK, PEEK)).split('\n').slice(1)];
  } finally {
    await fh.close();
  }
}

type Line = { type?: string; cwd?: string; timestamp?: string; customTitle?: string; aiTitle?: string; summary?: string; isSidechain?: boolean; isMeta?: boolean; message?: unknown };

/**
 * A transcript the SDK doesn't list (it skips ones whose every prompt starts with a tag, like
 * Conductor's <system_instruction>, when there's no title yet), summarized from the file itself.
 */
async function summarizeFile(file: string): Promise<Info | undefined> {
  const st = await stat(file).catch(() => undefined);
  if (!st) return undefined;
  const lines = await peek(file, st.size).catch(() => [] as string[]);
  let cwd: string | undefined;
  let createdAt: number | undefined;
  let firstPrompt: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let sidechain = false;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let l: Line;
    try {
      l = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (l.type === 'custom-title' && l.customTitle) customTitle = l.customTitle;
    if (l.type === 'ai-title' && l.aiTitle) aiTitle = l.aiTitle;
    if (l.type !== 'user' && l.type !== 'assistant') continue;
    cwd ??= l.cwd;
    if (l.timestamp && createdAt === undefined) createdAt = Date.parse(l.timestamp) || undefined;
    if (l.isSidechain && firstPrompt === undefined) sidechain = true;
    if (l.type === 'user' && !l.isMeta && firstPrompt === undefined) {
      const text = typedText(l.message);
      if (text && !text.startsWith('<')) firstPrompt = text;
    }
  }
  if (sidechain || !firstPrompt) return undefined;
  return { sessionId: path.basename(file, '.jsonl'), summary: aiTitle ?? firstPrompt, lastModified: Math.round(st.mtimeMs), ...(customTitle ? { customTitle } : {}), firstPrompt, ...(cwd ? { cwd } : {}), ...(createdAt ? { createdAt } : {}) };
}

/** Every Claude Code conversation that ran in exactly this folder, newest first. */
export async function listConversations(dir: string, limit = 50): Promise<ConversationSummary[]> {
  const found = new Map<string, ConversationSummary>();
  const fromSdk = (await listSessions({ dir, includeWorktrees: false, limit }).catch(() => [])) as Info[];
  for (const s of fromSdk) if (!s.cwd || samePath(s.cwd, dir)) found.set(s.sessionId, summaryOf(s));
  // Sessions the SDK didn't list: filed under another spelling of the folder (e.g. /tmp/x for
  // /private/tmp/x), or skipped by it for having no title yet.
  for (const variant of pathVariants(dir)) {
    for (const file of sessionFilesIn(variant)) {
      if (found.has(path.basename(file, '.jsonl'))) continue;
      const info = await summarizeFile(file);
      if (info && (!info.cwd || samePath(info.cwd, dir))) found.set(info.sessionId, summaryOf(info));
    }
  }
  return [...found.values()].sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
}

/** A conversation found under a folder (BLG-321): where it ran, and how big its transcript is. */
export interface FoundConversation extends ConversationSummary {
  readonly cwd: string;
  readonly bytes: number;
}

/** How many of a folder's newest transcripts are read for a list (each read is a peek at its ends). */
const UNDER_MAX = 150;

/**
 * Every Claude Code conversation that ran in a folder or in any folder inside it (Terminal, an
 * IDE, another tool), newest first, to bring one into Beluga. Claude Code's folder names can't be
 * told apart ("a/b-c" and "a-b/c" are filed alike), so each transcript's own folder decides.
 */
export async function conversationsUnder(dir: string, limit = UNDER_MAX): Promise<FoundConversation[]> {
  const projects = path.join(claudeConfigDir(), 'projects');
  let names: string[];
  try {
    names = readdirSync(projects);
  } catch {
    return [];
  }
  const roots = pathVariants(dir);
  const prefixes = roots.map(encodeProjectDir);
  const exact = new Set(prefixes);
  const inside = (cwd: string): boolean => pathVariants(cwd).some((c) => roots.some((r) => isUnder(r, c)));
  const files: Array<{ file: string; folder: string; mtime: number; size: number }> = [];
  for (const folder of names.filter((n) => prefixes.some((p) => n === p || n.startsWith(`${p}-`)))) {
    for (const file of transcriptsIn(path.join(projects, folder))) {
      const st = await stat(file).catch(() => undefined);
      if (st?.isFile()) files.push({ file, folder, mtime: st.mtimeMs, size: st.size });
    }
  }
  const out: FoundConversation[] = [];
  for (const f of files.sort((a, b) => b.mtime - a.mtime).slice(0, limit)) {
    const info = await summarizeFile(f.file);
    // No folder in it: only where it's filed under exactly this one.
    const cwd = info?.cwd ?? (exact.has(f.folder) ? path.resolve(dir) : undefined);
    if (info && cwd && inside(cwd)) out.push({ ...summaryOf(info), cwd, bytes: f.size });
  }
  return out;
}

/** The folder a transcript ran in, from its first lines that say. */
async function cwdOf(file: string): Promise<string | undefined> {
  const st = await stat(file).catch(() => undefined);
  if (!st) return undefined;
  for (const raw of await peek(file, Math.min(st.size, PEEK)).catch(() => [] as string[])) {
    try {
      const cwd = (JSON.parse(raw) as Line).cwd;
      if (cwd) return cwd;
    } catch {
      // A line cut short: the next one.
    }
  }
  return undefined;
}

/** What Claude Code keeps per session besides its transcript (edit history, env, to-dos). */
async function dropSessionExtras(root: string, sessionId: string): Promise<void> {
  if (!/^[\w-]{1,100}$/.test(sessionId)) return;
  for (const p of [path.join(root, 'file-history', sessionId), path.join(root, 'session-env', sessionId), path.join(root, 'debug', `${sessionId}.txt`)]) await rm(p, { recursive: true, force: true }).catch(() => undefined);
  const todos = path.join(root, 'todos');
  for (const f of await readdir(todos).catch(() => [] as string[])) if (f.startsWith(`${sessionId}-`)) await rm(path.join(todos, f), { force: true }).catch(() => undefined);
}

/**
 * Forget one Claude Code session that ran in a folder others share (a deleted chat's): its
 * transcript, its sub-agent and tool-result folder, and what Claude Code keeps for it elsewhere.
 */
export async function dropSession(dir: string, sessionId: string, root: string = claudeConfigDir()): Promise<void> {
  if (!/^[\w-]{1,100}$/.test(sessionId)) return;
  for (const variant of new Set(pathVariants(dir))) {
    const folder = path.join(root, 'projects', encodeProjectDir(variant));
    await rm(path.join(folder, `${sessionId}.jsonl`), { force: true }).catch(() => undefined);
    await rm(path.join(folder, sessionId), { recursive: true, force: true }).catch(() => undefined);
  }
  await dropSessionExtras(root, sessionId);
}

/**
 * Every folder inside `under` that Claude Code has sessions for, as each transcript says it ran
 * (folder names can't be read back: "a/b-c" and "a-b/c" are filed alike). For finding the ones a
 * deleted folder left behind.
 */
export async function sessionFoldersUnder(under: string, root: string = claudeConfigDir()): Promise<string[]> {
  const projects = path.join(root, 'projects');
  const prefixes = pathVariants(under).map((v) => `${encodeProjectDir(v)}-`);
  const inside = (cwd: string): boolean => pathVariants(under).some((v) => isUnder(v, cwd) && path.resolve(cwd) !== path.resolve(v));
  const out = new Set<string>();
  for (const name of await readdir(projects).catch(() => [] as string[])) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    for (const file of transcriptsIn(path.join(projects, name))) {
      const cwd = await cwdOf(file);
      if (cwd && inside(cwd)) out.add(path.resolve(cwd));
    }
  }
  return [...out];
}

/**
 * Forget every Claude Code session that ran in a folder being deleted for good (BLG-532): its
 * transcripts, their sub-agent and tool-result folders, and what Claude Code keeps per session
 * elsewhere. A transcript filed alike that ran in another folder ("a/b-c" and "a-b/c" are filed
 * alike) stays, and so does the folder then. Returns the bytes freed.
 */
export async function dropFolderSessions(dir: string, root: string = claudeConfigDir()): Promise<number> {
  let freed = 0;
  for (const variant of new Set(pathVariants(dir))) {
    const folder = path.join(root, 'projects', encodeProjectDir(variant));
    let keep = false;
    for (const file of transcriptsIn(folder)) {
      const cwd = await cwdOf(file);
      if (cwd && !samePath(cwd, dir)) {
        keep = true;
        continue;
      }
      const id = path.basename(file, '.jsonl');
      freed += (await stat(file).catch(() => undefined))?.size ?? 0;
      await rm(file, { force: true }).catch(() => undefined);
      await rm(path.join(folder, id), { recursive: true, force: true }).catch(() => undefined);
      await dropSessionExtras(root, id);
    }
    if (!keep) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
  return freed;
}

async function messagesOf(sessionId: string, dir: string): Promise<TranscriptMessage[]> {
  const inDir = (await getSessionMessages(sessionId, { dir }).catch(() => [])) as TranscriptMessage[];
  if (inDir.length) return inDir;
  // Filed under another spelling of the folder: look it up by id alone.
  return (await getSessionMessages(sessionId).catch(() => [])) as TranscriptMessage[];
}

export interface FindOptions {
  /** Exactly this conversation (it must have run in the folder). */
  readonly sessionId?: string;
  /** Try this one first (e.g. the one Conductor has open), then the newest. */
  readonly prefer?: string;
}

/**
 * A Claude Code conversation that ran in this folder, ready to show and to continue: the one
 * asked for, else the preferred one, else the newest that has something to show.
 */
export async function findConversation(dir: string, self: { id: string; name: string }, opts: FindOptions = {}): Promise<Conversation | undefined> {
  const all = await listConversations(dir);
  const candidates = opts.sessionId
    ? all.filter((c) => c.sessionId === opts.sessionId)
    : [...all.filter((c) => c.sessionId === opts.prefer), ...all.filter((c) => c.sessionId !== opts.prefer)].slice(0, 4);
  for (const pick of candidates) {
    const messages = await messagesOf(pick.sessionId, dir);
    // Claude Code records resolved paths, so steps read relative to the resolved folder.
    const { items, steps } = transcriptToTurns(messages, { selfId: self.id, selfName: self.name, cwd: realOf(dir), start: pick.createdAt ?? pick.lastModified, end: pick.lastModified });
    if (items.length) return { ...pick, items, steps, all };
  }
  return undefined;
}
