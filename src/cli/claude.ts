import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { belugaHome } from '../core/home.js';

/**
 * Claude's sign-in on a server: `claude setup-token` makes a long-lived token, kept here (0600) and
 * handed to the daemon as CLAUDE_CODE_OAUTH_TOKEN when it starts. Beluga never prints or logs it.
 */
export const claudeTokenPath = (): string => path.join(belugaHome(), 'claude-token');

/** What a Claude Code OAuth token looks like (sk-ant-oat01-…), so a mistyped paste is caught. */
export const looksLikeToken = (s: string): boolean => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(s.trim());

export function saveClaudeToken(token: string, file = claudeTokenPath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token.trim()}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function readClaudeToken(file = claudeTokenPath()): string | undefined {
  try {
    const token = readFileSync(file, 'utf8').trim();
    return looksLikeToken(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/** The kept token into this process's environment (the daemon's, so its runs inherit it), unless one is set already. */
export function useClaudeToken(env: NodeJS.ProcessEnv = process.env, file = claudeTokenPath()): boolean {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return false;
  const token = readClaudeToken(file);
  if (!token) return false;
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return true;
}

/** Run Claude Code's own `setup-token` on this terminal (it shows a link to open and asks for the code). */
export function runSetupToken(claude: string): Promise<number> {
  return new Promise((resolve) => {
    spawn(claude, ['setup-token'], { stdio: 'inherit' })
      .on('close', (code) => resolve(code ?? 1))
      .on('error', () => resolve(127));
  });
}
