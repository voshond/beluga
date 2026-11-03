import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A project's GitHub repository: where it is on the web (from the selected remote, ssh or https,
 * github.com or a GitHub Enterprise host), and what `gh` says about it (public or private,
 * people, open pull requests, stars). Nothing here asks for a sign-in: without `gh`, or signed
 * out, there's simply no info.
 */

export interface GitHubRepo {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  /** https://github.com/owner/repo */
  readonly url: string;
}

/** Hosts that are GitHub: github.com, and enterprise hosts named like it (github.acme.com, git.acme-github.io…). */
export const isGitHubHost = (host: string, known: readonly string[] = []): boolean => {
  const h = host.toLowerCase();
  return h === 'github.com' || h === 'www.github.com' || h === 'ssh.github.com' || /(^|[.-])github([.-]|$)/.test(h) || known.map((k) => k.toLowerCase()).includes(h);
};

/**
 * The repository a remote URL points at, when it's on GitHub: https://github.com/kay/app.git,
 * git@github.com:kay/app, ssh://git@github.acme.com:22/kay/app.git, git://…
 */
export function parseGitHubRemote(url: string, knownHosts: readonly string[] = []): GitHubRepo | undefined {
  const raw = url.trim();
  if (!raw) return undefined;
  let host: string | undefined;
  let rest: string | undefined;
  const full = /^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/(\S+)$/i.exec(raw);
  if (full) [host, rest] = [full[1], full[2]];
  else {
    // scp style (git@github.com:kay/app): needs a user@ or a dotted host, so "C:\code" isn't one.
    const scp = /^(?:([^@/\s]+)@)?([^:/\s]+):(?!\/\/)(\S+)$/.exec(raw);
    if (scp && (scp[1] || scp[2]!.includes('.'))) [host, rest] = [scp[2], scp[3]];
  }
  if (!host || !rest) return undefined;
  if (host === 'ssh.github.com') host = 'github.com';
  if (!isGitHubHost(host, knownHosts)) return undefined;
  const parts = rest.replace(/\.git\/?$/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  const [owner, repo] = parts.slice(-2) as [string, string];
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return undefined;
  const h = host.toLowerCase();
  return { host: h, owner, repo, url: `https://${h}/${owner}/${repo}` };
}

/** The hosts gh is signed in to (its hosts.yml top-level keys), so enterprise hosts with any name count. */
export function ghHosts(file = path.join(process.env.GH_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'gh'), 'hosts.yml')): string[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => /^([\w.-]+):\s*$/.exec(l)?.[1])
      .filter((h): h is string => Boolean(h));
  } catch {
    return [];
  }
}

export const commitUrl = (repo: GitHubRepo, hash: string): string => `${repo.url}/commit/${hash}`;

export type Visibility = 'public' | 'private' | 'internal';

export interface GitHubInfo {
  readonly visibility: Visibility;
  readonly stars: number;
  readonly forks: number;
  readonly openIssues: number;
  readonly defaultBranch?: string;
  /** People with access (collaborators), or who contributed when that list isn't readable. */
  readonly people?: number;
  readonly peopleKind?: 'collaborators' | 'contributors';
  readonly openPrs?: number;
  /** There are more open PRs than were counted (gh lists up to 1000). */
  readonly openPrsMore?: boolean;
  readonly archived?: boolean;
  readonly fetchedAt: number;
}

/** Runs `gh` with arguments; resolves stdout, rejects with gh's message. */
export type GhRunner = (args: readonly string[]) => Promise<string>;

export const runGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('gh', [...args], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });

/** `gh api repos/{o}/{r}` → the repo's basics. */
export function parseRepoJson(json: string): Omit<GitHubInfo, 'fetchedAt'> | undefined {
  try {
    const raw = JSON.parse(json) as { visibility?: string; private?: boolean; stargazers_count?: number; forks_count?: number; open_issues_count?: number; default_branch?: string; archived?: boolean };
    if (typeof raw !== 'object' || raw === null) return undefined;
    const visibility: Visibility = raw.visibility === 'internal' ? 'internal' : raw.visibility === 'private' || raw.private ? 'private' : 'public';
    return {
      visibility,
      stars: Number(raw.stargazers_count) || 0,
      forks: Number(raw.forks_count) || 0,
      openIssues: Number(raw.open_issues_count) || 0,
      ...(typeof raw.default_branch === 'string' ? { defaultBranch: raw.default_branch } : {}),
      ...(raw.archived ? { archived: true } : {}),
    };
  } catch {
    return undefined;
  }
}

/** `gh api --paginate …/collaborators` output (one JSON array per page, back to back) → how many. */
export function countPaginated(out: string): number {
  let n = 0;
  for (const chunk of out.split(/(?<=\])\s*(?=\[)/)) {
    try {
      const list = JSON.parse(chunk) as unknown;
      if (Array.isArray(list)) n += list.length;
    } catch {
      // Not an array: nothing to count in it.
    }
  }
  return n;
}

/**
 * How many entries a list has, from `gh api -i …?per_page=1`: the Link header's last page, else
 * the one entry (or none) in the body.
 */
export function countFromLinkHeader(response: string): number {
  const last = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/i.exec(response);
  if (last) return Number(last[1]);
  const body = response.slice(response.search(/\r?\n\r?\n/) + 1).trim();
  try {
    const list = JSON.parse(body) as unknown;
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

/** `gh pr list --json number` → how many. */
export function countJsonList(json: string): number | undefined {
  try {
    const list = JSON.parse(json) as unknown;
    return Array.isArray(list) ? list.length : undefined;
  } catch {
    return undefined;
  }
}

const MAX_PRS = 1000;

const hostArgs = (repo: GitHubRepo): string[] => (repo.host === 'github.com' ? [] : ['--hostname', repo.host]);

/**
 * What GitHub says about a repository, through `gh`. Undefined when gh isn't there, isn't signed
 * in, or can't see the repository. The people count and open PRs are best effort.
 */
export async function fetchGitHubInfo(repo: GitHubRepo, run: GhRunner = runGh, now = Date.now()): Promise<GitHubInfo | undefined> {
  const path = `repos/${repo.owner}/${repo.repo}`;
  const basics = await run(['api', ...hostArgs(repo), path]).then(parseRepoJson, () => undefined);
  if (!basics) return undefined;
  const [collaborators, prs] = await Promise.all([
    run(['api', ...hostArgs(repo), '--paginate', `${path}/collaborators?per_page=100`]).then(countPaginated, () => undefined),
    run(['pr', 'list', '--repo', `${repo.host}/${repo.owner}/${repo.repo}`, '--state', 'open', '--limit', String(MAX_PRS), '--json', 'number']).then(countJsonList, () => undefined),
  ]);
  const contributors = collaborators === undefined ? await run(['api', ...hostArgs(repo), '-i', `${path}/contributors?per_page=1&anon=1`]).then(countFromLinkHeader, () => undefined) : undefined;
  const people = collaborators ?? contributors;
  return {
    ...basics,
    ...(people !== undefined ? { people, peopleKind: collaborators !== undefined ? ('collaborators' as const) : ('contributors' as const) } : {}),
    ...(prs !== undefined ? { openPrs: prs, ...(prs >= MAX_PRS ? { openPrsMore: true } : {}) } : {}),
    fetchedAt: now,
  };
}
