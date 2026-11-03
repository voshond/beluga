import { z } from 'zod';
import { runGhCli } from '../core/issues/gh.js';
import type { GhRunner } from './github.js';

const Repository = z.object({ full_name: z.string(), clone_url: z.string(), ssh_url: z.string(), private: z.boolean(), archived: z.boolean() });

export const githubProjects = async (run: GhRunner = runGhCli) => {
  try {
    const [response, protocol] = await Promise.all([
      run(['api', '--hostname', 'github.com', '--paginate', '--slurp', 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member']),
      run(['config', 'get', 'git_protocol', '--host', 'github.com']).catch(() => 'https'),
    ]);
    const pages = z.array(z.array(Repository)).parse(JSON.parse(response));
    return pages.flat().map((repo) => ({ name: repo.full_name, url: protocol.trim() === 'ssh' ? repo.ssh_url : repo.clone_url, private: repo.private, archived: repo.archived }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|spawn .*gh/i.test(message)) throw new Error('Install the GitHub CLI (gh), then run gh auth login to see your repositories.');
    if (/auth login|not logged|HTTP 401|bad credentials/i.test(message)) throw new Error('Sign in to GitHub with gh auth login to see your repositories.');
    throw new Error(`Could not load GitHub repositories: ${message}`);
  }
};
