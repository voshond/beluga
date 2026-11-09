import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cachedGithubProjects, githubProjects } from '../src/workspaces/github-projects.js';
import type { GhRunner } from '../src/workspaces/github.js';

const repo = { full_name: 'team/app', clone_url: 'https://github.com/team/app.git', ssh_url: 'git@github.com:team/app.git', private: true, archived: false };

describe('GitHub project discovery', () => {
  let dir = '';
  let cache = '';

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-github-projects-'));
    cache = path.join(dir, 'github-repos.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists all pages and respects the configured Git protocol', async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push([...args]);
      return args[0] === 'config' ? 'ssh\n' : JSON.stringify([[repo], [{ ...repo, full_name: 'other/app', private: false }]]);
    };
    const projects = await githubProjects(run, cache);
    expect(projects).toEqual([{ name: 'team/app', url: repo.ssh_url, private: true, archived: false }, { name: 'other/app', url: repo.ssh_url, private: false, archived: false }]);
    expect(calls[0]).toContain('--paginate');
    expect(calls[0]?.at(-1)).toContain('organization_member');
  });

  it('uses HTTPS when the Git protocol is not configured', async () => {
    const run: GhRunner = async (args) => { if (args[0] === 'config') throw new Error('unset'); return JSON.stringify([[repo]]); };
    expect((await githubProjects(run, cache))[0]?.url).toBe(repo.clone_url);
  });

  it('explains missing CLI and sign-in failures', async () => {
    await expect(githubProjects(async () => { throw new Error('spawn gh ENOENT'); }, cache)).rejects.toThrow(/Install the GitHub CLI/);
    await expect(githubProjects(async () => { throw new Error('HTTP 401: Bad credentials'); }, cache)).rejects.toThrow(/gh auth login/);
  });

  it('keeps the last list so it shows at once next time', async () => {
    expect(cachedGithubProjects(cache)).toBeNull();
    const run: GhRunner = async (args) => (args[0] === 'config' ? 'https' : JSON.stringify([[repo]]));
    const repos = await githubProjects(run, cache, 1234);
    expect(cachedGithubProjects(cache)).toEqual({ fetchedAt: 1234, repos });
  });

  it('replaces the cached list with what GitHub returns and keeps it when a refresh fails', async () => {
    await githubProjects(async (args) => (args[0] === 'config' ? 'https' : JSON.stringify([[repo, { ...repo, full_name: 'gone/app' }]])), cache, 1);
    await githubProjects(async (args) => (args[0] === 'config' ? 'https' : JSON.stringify([[repo]])), cache, 2);
    expect(cachedGithubProjects(cache)?.repos.map((r) => r.name)).toEqual(['team/app']);
    await expect(githubProjects(async () => { throw new Error('HTTP 401: Bad credentials'); }, cache, 3)).rejects.toThrow();
    expect(cachedGithubProjects(cache)?.fetchedAt).toBe(2);
  });

  it('ignores a damaged cache file', () => {
    writeFileSync(cache, '{"repos": "nope"}');
    expect(cachedGithubProjects(cache)).toBeNull();
  });
});
