import { constants, copyFileSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ATTACHMENT_SCHEME, attachmentsDir, ownAttachment } from './attachments.js';
import { isSecretPath } from './shares.js';

/**
 * What you sent your agent with a message, kept where it works: each image linked in it and each
 * file the box attached (its path on a line of its own, in backticks) is copied into the
 * conversation's `.beluga/scratch/sent/`, and Claude is told where. So "put that screenshot in the
 * README" works a while later, when the image is no longer in front of it. Done as the message
 * reaches the agent (a run, a follow-up, a steer), never for one still waiting in the box.
 *
 * Copies, not links (the scratch listing follows none, and an original may move). Never a secret
 * (.env, keys: a worktree's scratch can be seen by friends it's shared with), never a folder, and
 * nothing too big to copy at once.
 */

/** Biggest file copied (a cloned copy on APFS costs nothing, elsewhere it's a real copy). */
export const MAX_SENT_BYTES = 200 * 1024 * 1024;

/** Something sent with a message: what the message calls it ("image 1", "report.pdf") and the file. */
export interface SentFile {
  readonly label: string;
  readonly src: string;
}

/** The images (yours, on this computer) and attached files a message names, in order, each once. */
export function sentFiles(prompt: string, selfId: string, dir = attachmentsDir()): SentFile[] {
  const out: SentFile[] = [];
  const add = (label: string, src: string): void => {
    if (!out.some((f) => f.src === src)) out.push({ label, src });
  };
  const scheme = ATTACHMENT_SCHEME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const links = new RegExp(`\\[📎 (image \\d+)[^\\]]*\\]\\(${scheme}([^/\\s)]+)/([^/\\s)]+)\\)`, 'g');
  for (const m of prompt.matchAll(links)) {
    if (m[2] !== selfId) continue; // a friend's image: on their computer
    const own = ownAttachment(m[3] ?? '', dir);
    if (own) add(m[1]!, own);
  }
  for (const m of prompt.matchAll(/^`([^`\n]+)`$/gm)) {
    const p = m[1]!;
    if (!path.isAbsolute(p) || isSecretPath(p)) continue;
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isFile() && st.size <= MAX_SENT_BYTES) add(path.basename(p), p);
  }
  return out;
}

/** Each part of the folder is a real folder (or not there yet), never a link out of the workspace. */
function noLinks(root: string, rel: string): boolean {
  let at = root;
  for (const part of rel.split('/')) {
    at = path.join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) return false;
  }
  return true;
}

/** A name in `dir` for a copy of `src`: its own, or the one it already has there (same size), else name-2, name-3… */
function nameFor(dir: string, src: string, size: number): { name: string; there: boolean } {
  const ext = path.extname(src);
  const stem = path.basename(src, ext);
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
    const st = lstatSync(path.join(dir, name), { throwIfNoEntry: false });
    if (!st) return { name, there: false };
    if (st.isFile() && st.size === size) return { name, there: true };
  }
  return { name: `${stem}-${Date.now()}${ext}`, there: false };
}

/** A copy kept: what the message called it and where it is, from the workspace's root. */
export interface KeptFile {
  readonly label: string;
  readonly path: string;
}

/** Copy what was sent into `rel` under `root` → where each copy is. Never throws: one that won't copy is left out. */
export function keepSent(root: string, rel: string, files: readonly SentFile[]): KeptFile[] {
  if (!files.length || !noLinks(root, rel)) return [];
  const dir = path.join(root, rel);
  const kept: KeptFile[] = [];
  for (const f of files) {
    try {
      mkdirSync(dir, { recursive: true });
      const { name, there } = nameFor(dir, f.src, statSync(f.src).size);
      if (!there) copyFileSync(f.src, path.join(dir, name), constants.COPYFILE_FICLONE);
      kept.push({ label: f.label, path: `${rel}/${name}` });
    } catch {
      // Gone, or no room: Claude still has the original (the image itself, or its path).
    }
  }
  return kept;
}

/** What Claude is told after the message: where each copy is. */
export function sentNote(kept: readonly KeptFile[]): string {
  if (!kept.length) return '';
  const each = kept.map((k) => (k.label === path.basename(k.path) ? `\`${k.path}\`` : `${k.label}: \`${k.path}\``)).join(', ');
  return `\n\n(Beluga keeps a copy of what was sent with this message in this folder, to work with later: ${each}.)`;
}

/** The message as the agent gets it: what it sent is copied into `rel` under `root`, and the message says where. */
export function withSentFiles(prompt: string, selfId: string, root: string, rel: string, dir = attachmentsDir()): string {
  if (prompt.startsWith('/')) return prompt; // a command goes as typed
  return prompt + sentNote(keepSent(root, rel, sentFiles(prompt, selfId, dir)));
}
