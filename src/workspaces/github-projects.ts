import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { belugaHome } from '../core/home.js';
import { runGhCli } from '../core/issues/gh.js';
import type { GhRunner } from './github.js';

const Repository = z.object({ full_name: z.string(), clone_url: z.string(), ssh_url: z.string(), private: z.boolean(), archived: z.boolean() });

const GithubProject = z.object({ name: z.string(), url: z.string(), private: z.boolean(), archived: z.boolean() });

export type GithubProject = z.infer<typeof GithubProject>;

const GithubProjectsCache = z.object({ fetchedAt: z.number(), repos: z.array(GithubProject) });

export type GithubProjectsCache = z.infer<typeof GithubProjectsCache>;

export const githubProjectsCachePath = (): string => path.join(belugaHome(), 'github-repos.json');

export const cachedGithubProjects = (file: string = githubProjectsCachePath()): GithubProjectsCache | null => {
  try {
    return GithubProjectsCache.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
};

const saveGithubProjects = (repos: readonly GithubProject[], file: string, now: number): void => {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ fetchedAt: now, repos })}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    return;
  }
};

export const githubProjects = async (run: GhRunner = runGhCli, file: string = githubProjectsCachePath(), now = Date.now()): Promise<GithubProject[]> => {
  try {
    const [response, protocol] = await Promise.all([
      run(['api', '--hostname', 'github.com', '--paginate', '--slurp', 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member']),
      run(['config', 'get', 'git_protocol', '--host', 'github.com']).catch(() => 'https'),
    ]);
    const pages = z.array(z.array(Repository)).parse(JSON.parse(response));
    const repos = pages.flat().map((repo) => ({ name: repo.full_name, url: protocol.trim() === 'ssh' ? repo.ssh_url : repo.clone_url, private: repo.private, archived: repo.archived }));
    saveGithubProjects(repos, file, now);
    return repos;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|spawn .*gh/i.test(message)) throw new Error('Install the GitHub CLI (gh), then run gh auth login to see your repositories.');
    if (/auth login|not logged|HTTP 401|bad credentials/i.test(message)) throw new Error('Sign in to GitHub with gh auth login to see your repositories.');
    throw new Error(`Could not load GitHub repositories: ${message}`);
  }
};
