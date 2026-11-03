import { existsSync } from 'node:fs';
import { samePath } from '../claude/claude-sessions.js';
import { findOpenCode } from './connection.js';
import { openCode } from './models.js';

/** An OpenCode session id ("ses_…"): only those are passed to its command line. */
const SESSION_ID = /^ses_[\w-]{1,100}$/;

/**
 * Forget OpenCode's own record of a conversation (a deleted chat's, BLG-571; a side call's or a
 * side question's fork, which were never yours to keep): `opencode session delete <id>`. Nothing
 * else of OpenCode's is touched; one that's already gone is fine.
 */
export async function dropOpenCodeSession(sessionId: string, bin: string | undefined = findOpenCode()): Promise<boolean> {
  if (!bin || !SESSION_ID.test(sessionId)) return false;
  return (await openCode(bin, ['session', 'delete', sessionId], 15_000)) !== undefined;
}

/**
 * Every OpenCode session that ran in a folder being deleted for good: listed from `from` (the
 * project's own folder: OpenCode files a repo's worktrees under one project, and `dir` may be
 * gone already), the ones in `dir` each deleted.
 */
export async function dropOpenCodeFolder(dir: string, from: string = dir, bin: string | undefined = findOpenCode()): Promise<number> {
  if (!bin || !existsSync(from)) return 0;
  const out = await openCode(bin, ['session', 'list', '--format', 'json'], 15_000, from);
  let listed: Array<{ id?: unknown; directory?: unknown }> = [];
  try {
    listed = out ? (JSON.parse(out.slice(Math.max(0, out.indexOf('[')))) as typeof listed) : [];
  } catch {
    return 0;
  }
  let dropped = 0;
  for (const s of listed) if (typeof s.id === 'string' && typeof s.directory === 'string' && samePath(s.directory, dir) && (await dropOpenCodeSession(s.id, bin))) dropped++;
  return dropped;
}
