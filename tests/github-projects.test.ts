import { describe, expect, it } from 'vitest';
import { githubProjects } from '../src/workspaces/github-projects.js';
import type { GhRunner } from '../src/workspaces/github.js';

const repo = { full_name: 'team/app', clone_url: 'https://github.com/team/app.git', ssh_url: 'git@github.com:team/app.git', private: true, archived: false };

describe('GitHub project discovery', () => {
  it('lists all pages and respects the configured Git protocol', async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push([...args]);
      return args[0] === 'config' ? 'ssh\n' : JSON.stringify([[repo], [{ ...repo, full_name: 'other/app', private: false }]]);
    };
    const projects = await githubProjects(run);
    expect(projects).toEqual([{ name: 'team/app', url: repo.ssh_url, private: true, archived: false }, { name: 'other/app', url: repo.ssh_url, private: false, archived: false }]);
    expect(calls[0]).toContain('--paginate');
    expect(calls[0]?.at(-1)).toContain('organization_member');
  });

  it('uses HTTPS when the Git protocol is not configured', async () => {
    const run: GhRunner = async (args) => { if (args[0] === 'config') throw new Error('unset'); return JSON.stringify([[repo]]); };
    expect((await githubProjects(run))[0]?.url).toBe(repo.clone_url);
  });

  it('explains missing CLI and sign-in failures', async () => {
    await expect(githubProjects(async () => { throw new Error('spawn gh ENOENT'); })).rejects.toThrow(/Install the GitHub CLI/);
    await expect(githubProjects(async () => { throw new Error('HTTP 401: Bad credentials'); })).rejects.toThrow(/gh auth login/);
  });
});
