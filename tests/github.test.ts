import { describe, expect, it } from 'vitest';
import { commitUrl, countFromLinkHeader, countJsonList, countPaginated, fetchGitHubInfo, isGitHubHost, parseGitHubRemote, parseRepoJson } from '../src/workspaces/github.js';

/** The project's GitHub repository from its remote, and gh's answers (mocked: never the network). */

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/kay/app.git', 'https://github.com/kay/app'],
    ['https://github.com/kay/app', 'https://github.com/kay/app'],
    ['https://token@github.com/kay/app.git', 'https://github.com/kay/app'],
    ['git@github.com:kay/app.git', 'https://github.com/kay/app'],
    ['git@github.com:kay/app', 'https://github.com/kay/app'],
    ['ssh://git@github.com/kay/app.git', 'https://github.com/kay/app'],
    ['ssh://git@ssh.github.com:443/kay/app.git', 'https://github.com/kay/app'],
    ['git://github.com/kay/my.app.git', 'https://github.com/kay/my.app'],
    ['git@github.acme.com:platform/api.git', 'https://github.acme.com/platform/api'],
    ['https://github.acme.io/platform/api', 'https://github.acme.io/platform/api'],
    ['ssh://git@ghe.acme.com:2222/platform/api.git', undefined],
    ['https://gitlab.com/kay/app.git', undefined],
    ['git@bitbucket.org:kay/app.git', undefined],
    ['/Users/kay/remotes/app.git', undefined],
    ['C:\\code\\app', undefined],
    ['https://github.com/kay', undefined],
    ['', undefined],
  ])('%s → %s', (url, web) => {
    expect(parseGitHubRemote(url)?.url).toBe(web);
  });

  it('knows enterprise hosts gh is signed in to', () => {
    expect(parseGitHubRemote('ssh://git@ghe.acme.com:2222/platform/api.git', ['ghe.acme.com'])).toEqual({ host: 'ghe.acme.com', owner: 'platform', repo: 'api', url: 'https://ghe.acme.com/platform/api' });
    expect(isGitHubHost('notgithubby.com')).toBe(false);
    expect(commitUrl(parseGitHubRemote('git@github.com:kay/app.git')!, 'abc123')).toBe('https://github.com/kay/app/commit/abc123');
  });
});

describe('gh answers', () => {
  it('reads the repo', () => {
    expect(parseRepoJson(JSON.stringify({ visibility: 'private', private: true, stargazers_count: 12, forks_count: 3, open_issues_count: 7, default_branch: 'main' }))).toEqual({ visibility: 'private', stars: 12, forks: 3, openIssues: 7, defaultBranch: 'main' });
    expect(parseRepoJson(JSON.stringify({ private: true }))?.visibility).toBe('private');
    expect(parseRepoJson(JSON.stringify({ visibility: 'internal' }))?.visibility).toBe('internal');
    expect(parseRepoJson(JSON.stringify({ archived: true }))).toMatchObject({ visibility: 'public', archived: true });
    expect(parseRepoJson('nope')).toBeUndefined();
  });

  it('counts pages, Link headers and lists', () => {
    expect(countPaginated('[{"id":1},{"id":2}][{"id":3}]')).toBe(3);
    expect(countPaginated('[]')).toBe(0);
    expect(countFromLinkHeader('HTTP/2.0 200 OK\nLink: <https://api.github.com/repositories/1/contributors?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/contributors?per_page=1&page=42>; rel="last"\n\n[{"login":"a"}]')).toBe(42);
    expect(countFromLinkHeader('HTTP/2.0 200 OK\nContent-Type: application/json\n\n[{"login":"a"}]')).toBe(1);
    expect(countJsonList('[{"number":1},{"number":2}]')).toBe(2);
    expect(countJsonList('{}')).toBeUndefined();
  });

  it('puts it together through gh (collaborators when readable, else contributors)', async () => {
    const repo = parseGitHubRemote('git@github.com:kay/app.git')!;
    const calls: string[][] = [];
    const gh = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      const joined = args.join(' ');
      if (joined === 'api repos/kay/app') return JSON.stringify({ visibility: 'public', stargazers_count: 5, forks_count: 1, open_issues_count: 2, default_branch: 'main' });
      if (joined.includes('/collaborators')) throw new Error('HTTP 403: Must have push access');
      if (joined.includes('/contributors')) return 'HTTP/2.0 200 OK\nLink: <https://x/contributors?per_page=1&page=9>; rel="last"\n\n[{}]';
      if (args[0] === 'pr') return '[{"number":4},{"number":7}]';
      throw new Error(`unexpected ${joined}`);
    };
    expect(await fetchGitHubInfo(repo, gh, 1000)).toEqual({ visibility: 'public', stars: 5, forks: 1, openIssues: 2, defaultBranch: 'main', people: 9, peopleKind: 'contributors', openPrs: 2, fetchedAt: 1000 });
    expect(calls.find((c) => c[0] === 'pr')).toEqual(['pr', 'list', '--repo', 'github.com/kay/app', '--state', 'open', '--limit', '1000', '--json', 'number']);
  });

  it('enterprise hosts go to gh with --hostname; no gh (or no access) means no info', async () => {
    const repo = parseGitHubRemote('git@github.acme.com:platform/api.git')!;
    const seen: string[][] = [];
    const info = await fetchGitHubInfo(repo, async (args) => {
      seen.push([...args]);
      if (args.includes('repos/platform/api')) return JSON.stringify({ visibility: 'internal' });
      if (args.some((a) => a.includes('collaborators'))) return '[{"login":"a"},{"login":"b"}]';
      return '[]';
    });
    expect(info).toMatchObject({ visibility: 'internal', people: 2, peopleKind: 'collaborators', openPrs: 0 });
    expect(seen[0]).toEqual(['api', '--hostname', 'github.acme.com', 'repos/platform/api']);
    expect(await fetchGitHubInfo(repo, async () => Promise.reject(new Error('gh: command not found')))).toBeUndefined();
  });
});

describe('MainSync.githubInfo', () => {
  // Not on Windows: a fake gh written as a shell script.
  it.skipIf(process.platform === 'win32')('caches gh’s answers for an hour, and says when a remote isn’t GitHub', async () => {
    const { MainSync } = await import('../src/core/main-sync.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { ghHosts } = await import('../src/workspaces/github.js');
    let remote = 'git@github.com:kay/app.git';
    let now = 0;
    let calls = 0;
    const sync = new MainSync({
      manager: { remoteOf: async () => remote } as never,
      refresh: async () => undefined,
      publish: () => undefined,
      toast: () => undefined,
      newChat: async () => undefined,
      newWorktree: async () => undefined,
      armSync: () => undefined,
      askClaude: () => undefined,
      open: () => undefined,
      ghHosts: () => [],
      now: () => now,
      gh: async (args) => {
        calls++;
        if (args.join(' ') === 'api repos/kay/app') return JSON.stringify({ visibility: 'private' });
        return '[]';
      },
    });
    const first = await sync.githubInfo('p');
    expect(first).toMatchObject({ kind: 'github', gh: true, repo: { url: 'https://github.com/kay/app' }, info: { visibility: 'private', people: 0, openPrs: 0 } });
    const made = calls;
    now = 30 * 60_000;
    await sync.githubInfo('p');
    expect(calls).toBe(made);
    now = 61 * 60_000;
    await sync.githubInfo('p');
    expect(calls).toBeGreaterThan(made);
    // Another remote is looked at again right away.
    remote = '/tmp/x.git';
    expect(await sync.githubInfo('p')).toEqual({ kind: 'none' });
    const dir = mkdtempSync(`${(await import('node:os')).tmpdir()}/klaud-gh-`);
    writeFileSync(`${dir}/hosts.yml`, 'github.com:\n    user: kay\nghe.acme.com:\n    user: kay\n');
    expect(ghHosts(`${dir}/hosts.yml`)).toEqual(['github.com', 'ghe.acme.com']);
    expect(ghHosts(`${dir}/missing.yml`)).toEqual([]);
  });
});

describe('gh and look-alike hosts', () => {
  it('only asks gh about github.com and hosts it is signed in to', async () => {
    const { MainSync } = await import('../src/core/main-sync.js');
    let calls = 0;
    const make = (remote: string, hosts: string[]) =>
      new MainSync({
        manager: { remoteOf: async () => remote } as never,
        refresh: async () => undefined,
        publish: () => undefined,
        toast: () => undefined,
        newChat: async () => undefined,
        newWorktree: async () => undefined,
        armSync: () => undefined,
        askClaude: () => undefined,
        open: () => undefined,
        ghHosts: () => hosts,
        gh: async () => {
          calls++;
          return JSON.stringify({ visibility: 'private' });
        },
      });
    const lookalike = await make('git@github.attacker.com:x/y.git', []).githubInfo('p');
    expect(lookalike).toMatchObject({ kind: 'github', gh: false, repo: { url: 'https://github.attacker.com/x/y' } });
    expect(calls).toBe(0);
    expect(await make('git@github.acme.com:x/y.git', ['github.acme.com']).githubInfo('p')).toMatchObject({ gh: true, info: { visibility: 'private' } });
    expect(calls).toBeGreaterThan(0);
  });
});
