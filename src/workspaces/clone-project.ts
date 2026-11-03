import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { tryGit } from './git.js';

const progress = new Map<string, string>();

export const cloneProgress = (target: string): string | undefined => progress.get(path.resolve(target));

export const cloneProject = async (remote: string, target: string): Promise<string> => {
  const url = remote.trim();
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/i.test(url)) throw new Error('Enter a GitHub HTTPS or SSH repository URL.');
  if (!target.trim()) throw new Error('Choose a target folder.');
  const dir = path.resolve(target);
  if (progress.has(dir)) throw new Error('A clone is already running for this folder.');
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) throw new Error('The target folder is not empty. Choose an empty folder.');
  progress.set(dir, 'Starting clone…');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['clone', '--progress', '--', url, dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' } });
      let output = '';
      child.stderr.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192);
        const lines = output.split(/[\r\n]/).map((line) => line.trim()).filter(Boolean);
        const last = lines.at(-1);
        if (last) progress.set(dir, last);
      });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Clone failed. Check the repository URL and your GitHub access. ${output.trim()}`)));
    });
    if (!(await tryGit(dir, ['rev-parse', '--verify', 'HEAD']))) throw new Error('The repository has no commits. Add a commit before using it for worktrees.');
    return dir;
  } finally {
    progress.delete(dir);
  }
};
