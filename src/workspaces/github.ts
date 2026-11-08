import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A project's GitHub repository: where it is on the web (from the origin remote, ssh or https,
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

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** The git folder of the checkout in `dir`: `.git`, or for a linked worktree (whose `.git` is a file) the folder it points at. */
export function gitDirOf(dir: string): string {
  const link = readText(path.join(dir, '.git'))?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  return link ? path.resolve(dir, link) : path.join(dir, '.git');
}

/** The git folder a checkout shares its config and refs from: its own, or a linked worktree's `commondir`. */
export function gitCommonDir(dir: string): string {
  const gitDir = gitDirOf(dir);
  const common = readText(path.join(gitDir, 'commondir'))?.trim();
  return common ? path.resolve(gitDir, common) : gitDir;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One value in a git config file's text: `[section "sub"]` … `key = value` (section and key in any case, as git reads them). */
export function configValue(config: string, section: string, sub: string, key: string): string | undefined {
  const header = new RegExp(`^\\[${escape(section)}\\s+"${escape(sub)}"\\]$`, 'i');
  const entry = new RegExp(`^${escape(key)}\\s*=\\s*(.+)$`, 'i');
  let inside = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inside = header.test(line);
      continue;
    }
    const value = inside ? entry.exec(line)?.[1]?.trim() : undefined;
    if (value) return value.replace(/^"(.*)"$/, '$1');
  }
  return undefined;
}

/** A remote's URL in a git config file's text (`[remote "origin"]` … `url = …`). */
export const remoteUrlIn = (config: string, remote = 'origin'): string | undefined => configValue(config, 'remote', remote, 'url');

/** The branch checked out in `dir` (undefined: a detached HEAD, or no checkout). */
export function currentBranch(dir: string): string | undefined {
  return readText(path.join(gitDirOf(dir), 'HEAD'))?.match(/^ref:\s*refs\/heads\/(.+)$/m)?.[1]?.trim();
}

const configOf = (dir: string): string | undefined => readText(path.join(gitCommonDir(dir), 'config'));

/** Where origin is on GitHub for the checkout in `dir`, read from its git config (no git run, no network). */
export function originRepo(dir: string, knownHosts: readonly string[] = ghHosts()): GitHubRepo | undefined {
  const config = configOf(dir);
  const url = config ? remoteUrlIn(config) : undefined;
  return url ? parseGitHubRemote(url, knownHosts) : undefined;
}

/** The git config key on a branch that says its pull request goes to another repository than origin's (a fork's original). */
export const PR_TARGET_KEY = 'belugaPrRepo';

/** "host/owner/repo", what GH_REPO takes. */
export const repoSlug = (repo: Pick<GitHubRepo, 'host' | 'owner' | 'repo'>): string => `${repo.host}/${repo.owner}/${repo.repo}`;

/** "github.com/rstagi/app" → the repository (undefined: not that shape). */
export function parseRepoSlug(slug: string): GitHubRepo | undefined {
  const m = /^([\w.-]+)\/([\w.-]+)\/([\w.-]+)$/.exec(slug.trim());
  return m ? { host: m[1]!.toLowerCase(), owner: m[2]!, repo: m[3]!, url: `https://${m[1]!.toLowerCase()}/${m[2]}/${m[3]}` } : undefined;
}

/**
 * Where the pull request of the branch checked out in `dir` goes, when it isn't origin: the
 * original repository of a fork, chosen with Create PR on the original (BLG-727), kept in the
 * branch's git config so every gh call about it (Beluga's and Claude's) finds it there.
 */
export function prTargetOf(dir: string, branch = currentBranch(dir)): GitHubRepo | undefined {
  const config = branch ? configOf(dir) : undefined;
  const slug = config ? configValue(config, 'branch', branch!, PR_TARGET_KEY) : undefined;
  return slug ? parseRepoSlug(slug) : undefined;
}

/**
 * The pull request a branch was checked out from, when it follows one (refs/pull/<n>/head, as a
 * fork's pull request opened in a worktree does): gh finds such a PR by its number, never by the
 * branch, which lives on the fork.
 */
export function pullOfBranch(dir: string, branch: string): number | undefined {
  const config = configOf(dir);
  const merge = config ? configValue(config, 'branch', branch, 'merge') : undefined;
  const n = merge ? /^refs\/pull\/(\d+)\/head$/.exec(merge)?.[1] : undefined;
  return n ? Number(n) : undefined;
}

/**
 * GH_REPO for gh run in `dir`: origin's repository. Without it, gh picks a remote itself, and in a
 * fork that's the original (an `upstream` remote ranks first, and `gh repo fork` saves it as the
 * default), so pull requests would be opened, read and merged there instead of on your fork. Origin
 * is what Beluga pushes to and merges into everywhere else. Empty when origin isn't on GitHub.
 */
export function originRepoEnv(dir: string | undefined, knownHosts?: readonly string[]): Record<string, string> {
  const repo = dir ? originRepo(dir, knownHosts) : undefined;
  return repo ? { GH_REPO: repoSlug(repo) } : {};
}

/** GH_REPO for gh about the branch in `dir`: where its pull request goes (the original, when its branch says so), else origin's. */
export function ghRepoEnv(dir: string | undefined, knownHosts?: readonly string[]): Record<string, string> {
  const target = dir && originRepo(dir, knownHosts) ? prTargetOf(dir) : undefined;
  return target ? { GH_REPO: repoSlug(target) } : originRepoEnv(dir, knownHosts);
}

/** The repository a fork was made from, and how far the fork's default branch is behind its. */
export interface ForkOf extends GitHubRepo {
  /** The original's default branch. */
  readonly branch: string;
  /** The fork's own default branch. */
  readonly forkBranch: string;
  /** Commits on the original's default branch that the fork's doesn't have (unset: GitHub didn't say). */
  readonly behind?: number;
}

/** `gh api repos/{fork}` → what it was forked from; null when it isn't a fork, undefined when the answer isn't readable. */
export function parseForkJson(json: string, host: string): Omit<ForkOf, 'behind'> | null | undefined {
  try {
    const raw = JSON.parse(json) as { fork?: boolean; default_branch?: string; parent?: { name?: string; default_branch?: string; owner?: { login?: string } } };
    if (typeof raw !== 'object' || raw === null) return undefined;
    const owner = raw.parent?.owner?.login;
    const repo = raw.parent?.name;
    if (!raw.fork || !owner || !repo) return null;
    const h = host.toLowerCase();
    return { host: h, owner, repo, url: `https://${h}/${owner}/${repo}`, branch: raw.parent?.default_branch || 'main', forkBranch: raw.default_branch || 'main' };
  } catch {
    return undefined;
  }
}

/**
 * Whether `repo` is a fork, and of what, with how many commits the original's default branch has
 * that the fork's doesn't (GitHub's compare across the fork network). null: not a fork. Throws
 * when gh couldn't tell.
 */
export async function fetchFork(repo: GitHubRepo, run: GhRunner = runGh): Promise<ForkOf | null> {
  const fork = parseForkJson(await run(['api', ...hostArgs(repo), `repos/${repo.owner}/${repo.repo}`]), repo.host);
  if (fork === undefined) throw new Error('GitHub gave something unexpected about the repository');
  if (!fork) return null;
  const compare = `repos/${repo.owner}/${repo.repo}/compare/${fork.forkBranch}...${fork.owner}:${fork.repo}:${fork.branch}`;
  const behind = await run(['api', ...hostArgs(repo), compare, '--jq', '.ahead_by']).then(
    (out) => (/^\d+$/.test(out.trim()) ? Number(out.trim()) : undefined),
    () => undefined,
  );
  return { ...fork, ...(behind !== undefined ? { behind } : {}) };
}

export type UpstreamMerge = { readonly kind: 'none' | 'fast-forward' | 'merge' } | { readonly kind: 'conflict'; readonly message: string } | { readonly kind: 'failed'; readonly message: string };

/**
 * GitHub's Sync fork: bring the original's new commits into the fork's `branch`, on GitHub
 * (`POST repos/{fork}/merge-upstream`): a fast-forward, or a merge commit when the fork has commits
 * of its own; nothing when it's already up to date. A conflict (409) changes nothing.
 */
export async function mergeUpstream(repo: GitHubRepo, branch: string, run: GhRunner = runGh): Promise<UpstreamMerge> {
  try {
    const out = await run(['api', ...hostArgs(repo), '-X', 'POST', `repos/${repo.owner}/${repo.repo}/merge-upstream`, '-f', `branch=${branch}`]);
    const kind = (JSON.parse(out) as { merge_type?: string }).merge_type;
    return { kind: kind === 'merge' || kind === 'fast-forward' ? kind : 'none' };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split('\n').find((l) => l.trim())?.replace(/^gh:\s*/, '').trim() ?? 'GitHub didn’t sync the fork';
    return /HTTP 409|conflict/i.test(message) ? { kind: 'conflict', message } : { kind: 'failed', message };
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
