import { describe, expect, it } from 'vitest';
import { type ReadyDeps, Readying, userEnv } from '../src/machines/ready.js';
import { type ReadyRun, type ReadySystem, cloneTarget, cloneTrouble, installPlan, missingOf, needsOf, projectsFolder, readyLine, satisfies, systemNote, toolWords } from '../src/machines/ready-model.js';
import { cloneableOrigin, githubSlug, repoKey, repoName, sameRepo } from '../src/shared/repo-key.js';
import { waitFor } from './helpers.js';

/**
 * Getting a computer ready for a project (BLG-787): the repository however its origin is written,
 * what a project needs from its files, what's missing and how it's installed there (a user-level
 * way first, sudo only when allowed), the projects folder per system, git's errors in plain words,
 * and a run step by step on a pretend computer.
 */

describe('one repository however it’s written', () => {
  it.each([
    ['git@github.com:Kayra/bob-api.git', 'github.com/kayra/bob-api', 'bob-api', 'Kayra/bob-api'],
    ['https://github.com/Kayra/bob-api', 'github.com/kayra/bob-api', 'bob-api', 'Kayra/bob-api'],
    ['ssh://git@github.com/Kayra/bob-api.git', 'github.com/kayra/bob-api', 'bob-api', 'Kayra/bob-api'],
    ['https://gitlab.com/group/sub/app.git', 'gitlab.com/group/sub/app', 'app', undefined],
  ])('%s', (origin, key, name, slug) => {
    expect(repoKey(origin)).toBe(key);
    expect(repoName(origin)).toBe(name);
    expect(githubSlug(origin)).toBe(slug);
    expect(cloneableOrigin(origin)).toBe(true);
  });

  it('never hands git an option or something that isn’t an address', () => {
    expect(cloneableOrigin('--upload-pack=touch /tmp/x')).toBe(false);
    expect(cloneableOrigin('file:///etc')).toBe(false);
    expect(cloneableOrigin('https://github.com/a/b c')).toBe(false);
    expect(sameRepo('git@github.com:a/b.git', 'https://github.com/A/B')).toBe(true);
  });
});

describe('what a project needs', () => {
  it.each([
    ['.nvmrc and a pnpm lockfile', { '.nvmrc': '20\n', 'package.json': '{}', 'pnpm-lock.yaml': '' }, ['Node 20', 'pnpm']],
    ['package.json engines and npm', { 'package.json': '{"engines":{"node":">=18"}}', 'package-lock.json': '' }, ['Node 18 or later']],
    ['packageManager says yarn', { 'package.json': '{"packageManager":"yarn@4.1.0"}' }, ['Node', 'Yarn']],
    ['.tool-versions', { '.tool-versions': 'nodejs 20.11.0\npython 3.12.1\n' }, ['Node 20.11', 'Python 3.12']],
    ['pyproject with uv', { 'pyproject.toml': 'requires-python = ">=3.10"', 'uv.lock': '' }, ['Python 3.10 or later', 'uv']],
    ['a Gemfile', { Gemfile: "source 'https://rubygems.org'", '.ruby-version': 'ruby-3.3.0' }, ['Ruby 3.3', 'Bundler']],
    ['go.mod', { 'go.mod': 'module x\n\ngo 1.22\n' }, ['Go 1.22 or later']],
    ['nothing at all', {}, []],
  ])('%s', (_case, files, words) => {
    expect(needsOf(files).map((n) => toolWords(n))).toEqual(words);
  });

  it.each([
    [{ version: '20' }, 'v20.11.1', true],
    [{ version: '20' }, 'v18.19.0', false],
    [{ version: '>=18' }, 'v20.1.0', true],
    [{ version: '>=1.22' }, 'go1.21.5', false],
    [{ version: '3.12' }, '3.12.3', true],
    [{ version: '3.12' }, '3.11.9', false],
    [{ version: 'lts/*' }, 'v16.0.0', true],
    [{}, '1.0.0', true],
    [{}, undefined, false],
  ])('%j with %s: %s', (need, have, ok) => {
    expect(satisfies(need, have === undefined ? undefined : (/(\d+\.\d+(?:\.\d+)?)/.exec(have)?.[1] ?? have))).toBe(ok);
  });

  it('says what it has instead', () => {
    const missing = missingOf(needsOf({ '.nvmrc': '20', 'pnpm-lock.yaml': '' }), { node: '18.19.0' });
    expect(missing.map((m) => m.words)).toEqual(['Node 20 (it has 18.19)', 'pnpm']);
  });
});

describe('installing what’s missing, the system’s own way', () => {
  const ubuntu: ReadySystem = { platform: 'linux', release: 'Ubuntu 24.04', pkg: 'apt', sudo: false, nvm: false };
  const mac: ReadySystem = { platform: 'macos', pkg: 'brew', sudo: false, nvm: true };
  const missing = (tool: Parameters<typeof toolWords>[0]['tool'], version?: string) => ({ need: { tool, ...(version ? { version } : {}), from: 'x' }, words: toolWords({ tool, ...(version ? { version } : {}) }) });

  it('Node with nvm, for you only, installing nvm first when it isn’t there', () => {
    const plan = installPlan(missing('node', '20'), ubuntu);
    expect(plan).toMatchObject({ can: true, sudo: false, words: 'Node 20 with nvm, for you only' });
    expect(plan.command).toContain('nvm-sh/nvm');
    expect(plan.command).toContain('nvm install 20');
    expect(installPlan(missing('node', '20'), mac).command).not.toContain('nvm-sh/nvm');
  });

  it('Python with uv and pnpm in your own folder: never sudo', () => {
    expect(installPlan(missing('python', '3.12'), ubuntu)).toMatchObject({ sudo: false, can: true });
    expect(installPlan(missing('python', '3.12'), ubuntu).command).toContain('python install 3.12');
    expect(installPlan(missing('pnpm'), ubuntu).command).toBe('npm install -g --prefix "$HOME/.local" pnpm');
  });

  it('Go has no user-level way: brew on a Mac, apt with sudo only when sudo works without asking', () => {
    expect(installPlan(missing('go'), mac)).toMatchObject({ can: true, sudo: false, command: 'brew install go' });
    const noSudo = installPlan(missing('go'), ubuntu);
    expect(noSudo).toMatchObject({ can: false, sudo: true });
    expect(noSudo.why).toBe('Go needs an administrator there: run `sudo apt-get install -y golang-go`');
    expect(installPlan(missing('go'), { ...ubuntu, sudo: true })).toMatchObject({ can: true, command: 'sudo -n apt-get install -y golang-go' });
    expect(installPlan(missing('go'), { ...ubuntu, pkg: 'dnf', sudo: true }).command).toBe('sudo -n dnf install -y golang');
    expect(installPlan(missing('go'), { ...ubuntu, pkg: 'apk', sudo: true }).command).toBe('sudo -n apk add go');
  });

  it('tells the setup agent which system it is', () => {
    expect(systemNote(ubuntu)).toBe('Linux (Ubuntu 24.04), packages with apt, no sudo');
    expect(systemNote(mac)).toBe('macOS, packages with brew, Node by nvm');
  });
});

describe('where projects go', () => {
  it('one that’s there already, else ~/Projects on a Mac and ~/projects on Linux, or the one set there', () => {
    expect(projectsFolder('macos', '/Users/k', () => false)).toBe('/Users/k/Projects');
    expect(projectsFolder('linux', '/home/k', () => false)).toBe('/home/k/projects');
    expect(projectsFolder('linux', '/home/k', (d) => d === '/home/k/code')).toBe('/home/k/code');
    expect(projectsFolder('linux', '/home/k', () => false, '~/src')).toBe('/home/k/src');
    expect(cloneTarget('/home/k/projects', 'bob-api', (d) => d === '/home/k/projects/bob-api')).toBe('/home/k/projects/bob-api-2');
  });

  it('git’s trouble in plain words, with Sign In There when GitHub isn’t signed in', () => {
    expect(cloneTrouble('git@github.com: Permission denied (publickey).', 'build-box', 'signed_out')).toEqual({ words: 'build-box isn’t signed in to GitHub, so it can’t get the repository', fix: { words: 'Sign In There', command: 'gh auth login' } });
    expect(cloneTrouble('ERROR: Repository not found.', 'build-box', 'signed_in').words).toBe('build-box can’t find the repository: it may be private, or its address changed');
    expect(cloneTrouble('fatal: unable to access: Could not resolve host: github.com', 'pi', 'signed_in').words).toBe('pi can’t reach the repository’s server right now');
  });
});

describe('a run on a pretend computer', () => {
  function computer(over: Partial<ReadyDeps> & { tools?: Record<string, string>; cloneFails?: string } = {}) {
    const ran: string[] = [];
    const dirs = new Set<string>(['/home/k']);
    const files: Record<string, string> = {};
    const projects: Array<{ id: string; name: string; root: string }> = [];
    const tools = { ...over.tools };
    const deps: ReadyDeps = {
      name: () => 'build-box',
      home: '/home/k',
      platform: 'linux',
      sh: async (command, opts) => {
        ran.push(command);
        if (command === 'npm ci') return tools.node ? { code: 0, out: `ran in ${opts?.cwd}` } : { code: 127, out: 'npm: command not found' };
        if (command.includes(' clone ')) {
          if (over.cloneFails) return { code: 128, out: over.cloneFails };
          dirs.add('/home/k/projects/bob-api');
          files['/home/k/projects/bob-api/.nvmrc'] = '20\n';
          files['/home/k/projects/bob-api/package.json'] = '{}';
          files['/home/k/projects/bob-api/package-lock.json'] = '';
          return { code: 0, out: '' };
        }
        if (command.includes('nvm install 20')) {
          tools.node = 'v20.11.1';
          return { code: 0, out: '' };
        }
        const version = /^(\w+)/.exec(command)?.[1];
        const tool = version === 'python3' ? 'python' : version === 'bundle' ? 'bundler' : version;
        if (tool && tools[tool]) return { code: 0, out: tools[tool]! };
        return { code: 127, out: `${version}: command not found` };
      },
      isDir: (d) => dirs.has(d),
      mkdir: (d) => void dirs.add(d),
      readFile: (f) => files[f],
      projects: () => projects,
      origin: async (root) => (root === '/home/k/projects/landing' ? 'git@github.com:k/landing.git' : undefined),
      addProject: async (dir) => {
        projects.push({ id: 'p-new', name: 'bob-api', root: dir });
        return { id: 'p-new' };
      },
      workOutSetup: async () => 'npm ci',
      gh: async () => 'signed_in',
      system: async () => ({ platform: 'linux', pkg: 'apt', sudo: false, nvm: false }),
      ...over,
    };
    return { deps, ran, projects };
  }
  const settled = async (r: Readying, id: string, states: ReadonlyArray<ReadyRun['state']>): Promise<ReadyRun> => {
    await waitFor(() => states.includes(r.status(id)!.state));
    return r.status(id)!;
  };

  it('clones a missing project into ~/projects with gh, names a missing Node, installs it only once asked, then works out setup', async () => {
    const c = computer();
    const r = new Readying(c.deps);
    const started = r.start('git@github.com:Kayra/bob-api.git');
    expect(readyLine(started)).toBe('Getting build-box ready: its folder, cloning, tools, setup');
    const asking = await settled(r, started.id, ['asking', 'failed', 'done']);
    expect(asking.state).toBe('asking');
    expect(c.ran.some((cmd) => cmd === "gh repo clone 'Kayra/bob-api' '/home/k/projects/bob-api'")).toBe(true);
    expect(asking.path).toBe('/home/k/projects/bob-api');
    expect(asking.steps.find((s) => s.id === 'folder')).toMatchObject({ state: 'done', detail: '~/projects' });
    expect(asking.steps.find((s) => s.id === 'tools')).toMatchObject({ state: 'asking', detail: 'Missing on build-box: Node 20' });
    expect(asking.missing?.[0]).toMatchObject({ tool: 'node', can: true, sudo: false });
    // Nothing installed before you said so.
    expect(c.ran.some((cmd) => cmd.includes('nvm install'))).toBe(false);
    expect(readyLine(asking)).toBe('build-box needs tools installed first');

    r.install(started.id);
    const done = await settled(r, started.id, ['done', 'failed']);
    expect(done.state).toBe('done');
    expect(c.ran.some((cmd) => cmd.includes('nvm install 20'))).toBe(true);
    expect(done.steps.find((s) => s.id === 'tools')).toMatchObject({ state: 'done', label: 'Node 20' });
    expect(done.steps.find((s) => s.id === 'setup')).toMatchObject({ state: 'done', label: 'Setup: npm ci' });
    // Setup ran once, in the project's folder, after the tools were there.
    expect(c.ran.filter((cmd) => cmd === 'npm ci')).toHaveLength(1);
    expect(c.ran.indexOf('npm ci')).toBeGreaterThan(c.ran.findIndex((cmd) => cmd.includes('nvm install 20')));
    expect(done).toMatchObject({ projectId: 'p-new', setup: 'npm ci' });
    expect(readyLine(done)).toBe('build-box is ready');
  });

  it('a project already there is found by its origin, not cloned again', async () => {
    const c = computer({ tools: { node: 'v20.1.0' } });
    c.projects.push({ id: 'p-landing', name: 'landing', root: '/home/k/projects/landing' });
    const r = new Readying(c.deps);
    const run = r.start('https://github.com/k/landing');
    const done = await settled(r, run.id, ['done', 'failed', 'asking']);
    expect(done).toMatchObject({ state: 'done', projectId: 'p-landing' });
    expect(done.steps.find((s) => s.id === 'clone')).toMatchObject({ state: 'skipped', label: 'landing is here' });
    expect(c.ran.some((cmd) => cmd.includes('clone'))).toBe(false);
  });

  it('a clone GitHub refuses says so in plain words, with Sign In There', async () => {
    const c = computer({ gh: async () => 'signed_out', cloneFails: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' });
    const r = new Readying(c.deps);
    const run = r.start('git@github.com:Kayra/bob-api.git');
    const failed = await settled(r, run.id, ['failed', 'done']);
    expect(failed.state).toBe('failed');
    expect(c.ran.some((cmd) => cmd.startsWith('GIT_TERMINAL_PROMPT=0 git clone '))).toBe(true);
    expect(failed.steps.find((s) => s.id === 'clone')).toMatchObject({ state: 'failed', error: 'build-box isn’t signed in to GitHub, so it can’t get the repository', fix: { words: 'Sign In There', command: 'gh auth login' } });
    expect(readyLine(failed)).toBe('build-box couldn’t get ready: build-box isn’t signed in to GitHub, so it can’t get the repository');
  });

  it('refuses an origin that isn’t a git address, and gives the same run while one is going', () => {
    const r = new Readying(computer().deps);
    expect(() => r.start('--upload-pack=x')).toThrow();
    const a = r.start('git@github.com:Kayra/bob-api.git');
    expect(r.start('https://github.com/kayra/bob-api').id).toBe(a.id);
  });
});

describe('the user’s own environment for its commands (BLG-842)', () => {
  it('drops what npm set for Beluga itself, and sets the user’s home', () => {
    const env = userEnv({ PATH: '/usr/bin', npm_config_prefix: '/opt/homebrew', npm_lifecycle_event: 'dev', NPM_CONFIG_CACHE: '/x', LANG: 'en_US.UTF-8' }, '/home/kay');
    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'en_US.UTF-8', HOME: '/home/kay', GIT_TERMINAL_PROMPT: '0' });
  });

  it('loads nvm without using a Node (it has none yet right after installing)', () => {
    const plan = installPlan({ need: { tool: 'node', version: '20', from: '.nvmrc' }, words: 'Node 20' }, { platform: 'linux', sudo: false, nvm: false });
    expect(plan.command).toContain('. "$HOME/.nvm/nvm.sh" --no-use && nvm install 20');
  });
});
