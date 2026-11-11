import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkSetup, detectRun, detectSetup, nestedPackages, readProjectFile, resolveScripts, saveProjectFile, scriptEnv } from '../src/workspaces/scripts.js';

let dir: string;
const touch = (name: string, content = '') => writeFileSync(path.join(dir, name), content);
const pkg = (scripts: Record<string, unknown>) => touch('package.json', JSON.stringify({ name: 'x', scripts }));

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-scripts-'));
});

describe('detectSetup', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm install'],
    ['yarn.lock', 'yarn install'],
    ['bun.lockb', 'bun install'],
    ['bun.lock', 'bun install'],
    ['package-lock.json', 'npm install'],
    ['uv.lock', 'uv sync'],
    ['poetry.lock', 'poetry install'],
    ['Gemfile.lock', 'bundle install'],
    ['composer.lock', 'composer install'],
  ])('%s → %s', (file, command) => {
    touch(file);
    expect(detectSetup(dir)).toBe(command);
  });

  it('prefers pnpm over package-lock when both exist', () => {
    touch('package-lock.json');
    touch('pnpm-lock.yaml');
    expect(detectSetup(dir)).toBe('pnpm install');
  });

  it('falls back to npm install for a bare package.json', () => {
    pkg({});
    expect(detectSetup(dir)).toBe('npm install');
  });

  it('creates a venv for requirements.txt', () => {
    touch('requirements.txt');
    expect(detectSetup(dir, 'darwin')).toBe('python3 -m venv .venv && .venv/bin/pip install -r requirements.txt');
    expect(detectSetup(dir, 'win32')).toBe('python -m venv .venv && .venv/Scripts/pip install -r requirements.txt');
  });

  it('returns undefined for an empty folder', () => {
    expect(detectSetup(dir)).toBeUndefined();
  });

  describe('nested packages with their own lockfile', () => {
    const sub = (at: string, files: string[]) => {
      mkdirSync(path.join(dir, at), { recursive: true });
      for (const f of files) touch(path.join(at, f), f === 'package.json' ? '{}' : '');
    };

    it('installs each one after the root (a root npm install leaves them empty)', () => {
      pkg({});
      touch('package-lock.json');
      sub('packages/mac', ['package.json', 'package-lock.json']);
      sub('packages/web', ['package.json', 'pnpm-lock.yaml']);
      sub('packages/shared', ['package.json']); // no lockfile of its own: not installed on its own
      sub('apps/site', ['README.md']);
      expect(detectSetup(dir)).toBe('npm install && (cd packages/mac && npm install) && (cd packages/web && pnpm install)');
      expect(nestedPackages(dir)).toEqual(['packages/mac', 'packages/web']);
    });

    it('leaves them to the root when it has workspaces or installs them itself', () => {
      sub('packages/mac', ['package.json', 'package-lock.json']);
      touch('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
      expect(detectSetup(dir)).toBe('npm install');
      touch('package.json', JSON.stringify({ scripts: { postinstall: 'cd packages/mac && npm ci' } }));
      expect(detectSetup(dir)).toBe('npm install');
      touch('package.json', '{}');
      touch('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
      expect(detectSetup(dir)).toBe('npm install');
    });

    it('installs them with no package.json at the root', () => {
      sub('apps/api', ['package.json', 'yarn.lock']);
      expect(detectSetup(dir)).toBe('(cd apps/api && yarn install)');
    });
  });
});

describe("the project's own tooling", () => {
  const tmp = (files: Record<string, string>): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-tooling-'));
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(d, name), content);
    return d;
  };
  it('uses Makefile and justfile targets before guessing from files', () => {
    const dir = tmp({ Makefile: 'VERSION := 1\n.PHONY: deps run\ndeps:\n\tnpm ci\nrun build: deps\n\tnode .\n', 'package-lock.json': '{}', 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }) });
    expect(detectSetup(dir)).toBe('make deps');
    expect(detectRun(dir)).toBe('make run');
    const just = tmp({ justfile: 'set shell := ["bash", "-c"]\n@setup:\n    uv sync\nserve port="8000":\n    uv run app\n' });
    expect(detectSetup(just)).toBe('just setup');
    expect(detectRun(just)).toBe('just serve');
  });

  it("never runs `make install` (it often installs into the system), and falls back to the files", () => {
    const dir = tmp({ Makefile: 'install:\n\tcp app /usr/local/bin\n', 'package-lock.json': '{}', 'package.json': '{}' });
    expect(detectSetup(dir)).toBe('npm install');
    expect(detectRun(dir)).toBeUndefined();
  });

  it("shows commands Claude worked out as Claude's", () => {
    const dir = tmp({});
    expect(resolveScripts(dir, { run: 'make it', setup: 'mine', byClaude: ['run'] })).toEqual({ setup: { command: 'mine', source: 'yours' }, run: { command: 'make it', source: 'claude' } });
  });
});

describe('detectRun', () => {
  it('uses npm run dev by default', () => {
    pkg({ dev: 'vite', start: 'node .' });
    expect(detectRun(dir)).toBe('npm run dev');
  });

  it('falls back to start when there is no dev', () => {
    pkg({ start: 'node .' });
    expect(detectRun(dir)).toBe('npm run start');
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm dev'],
    ['yarn.lock', 'yarn dev'],
    ['bun.lockb', 'bun dev'],
    ['bun.lock', 'bun dev'],
  ])('with %s runs %s', (lock, command) => {
    touch(lock);
    pkg({ dev: 'vite' });
    expect(detectRun(dir)).toBe(command);
  });

  it('uses the runner for start too', () => {
    touch('yarn.lock');
    pkg({ start: 'node .' });
    expect(detectRun(dir)).toBe('yarn start');
  });

  it('ignores non-string scripts', () => {
    pkg({ dev: 42 });
    expect(detectRun(dir)).toBeUndefined();
  });

  it('ignores invalid package.json', () => {
    touch('package.json', '{not json');
    touch('Cargo.toml');
    expect(detectRun(dir)).toBe('cargo run');
  });

  it('detects cargo and go', () => {
    touch('Cargo.toml');
    expect(detectRun(dir)).toBe('cargo run');
    const other = mkdtempSync(path.join(os.tmpdir(), 'klaud-scripts-go-'));
    writeFileSync(path.join(other, 'go.mod'), 'module x\n');
    expect(detectRun(other)).toBe('go run .');
  });

  it('prefers package.json scripts over Cargo.toml', () => {
    pkg({ dev: 'vite' });
    touch('Cargo.toml');
    expect(detectRun(dir)).toBe('npm run dev');
  });

  it('returns undefined when nothing matches', () => {
    pkg({ build: 'tsc' });
    expect(detectRun(dir)).toBeUndefined();
  });
});

describe('readProjectFile', () => {
  it('returns nothing for missing or invalid files', () => {
    expect(readProjectFile(dir)).toEqual({ file: undefined, name: 'beluga.json', conductor: undefined });
    touch('beluga.json', '{oops');
    touch('conductor.json', JSON.stringify({ scripts: { setup: '' } }));
    expect(readProjectFile(dir)).toEqual({ file: undefined, name: 'beluga.json', conductor: undefined });
  });

  it('defaults scripts to {} and trims commands', () => {
    touch('beluga.json', JSON.stringify({ prPrompt: 'hi' }));
    touch('conductor.json', JSON.stringify({ scripts: { run: '  make  ' } }));
    expect(readProjectFile(dir)).toEqual({ file: { scripts: {}, prPrompt: 'hi' }, name: 'beluga.json', conductor: { run: 'make' } });
  });
});

describe('resolveScripts', () => {
  it('prefers yours > beluga.json > conductor.json > detected', () => {
    touch('package-lock.json');
    pkg({ dev: 'vite' });
    expect(resolveScripts(dir)).toEqual({ setup: { command: 'npm install', source: 'detected' }, run: { command: 'npm run dev', source: 'detected' } });

    touch('conductor.json', JSON.stringify({ scripts: { setup: 'c-setup', run: 'c-run' } }));
    expect(resolveScripts(dir)).toEqual({ setup: { command: 'c-setup', source: 'conductor.json' }, run: { command: 'c-run', source: 'conductor.json' } });

    touch('beluga.json', JSON.stringify({ scripts: { setup: 'b-setup' } }));
    expect(resolveScripts(dir)).toEqual({ setup: { command: 'b-setup', source: 'beluga.json' }, run: { command: 'c-run', source: 'conductor.json' } });

    expect(resolveScripts(dir, { run: 'mine' })).toEqual({ setup: { command: 'b-setup', source: 'beluga.json' }, run: { command: 'mine', source: 'yours' } });
  });

  it('treats an empty string of yours as unset', () => {
    touch('beluga.json', JSON.stringify({ scripts: { setup: 'b-setup' } }));
    expect(resolveScripts(dir, { setup: '' }).setup).toEqual({ command: 'b-setup', source: 'beluga.json' });
  });

  it('omits keys when nothing is found', () => {
    expect(resolveScripts(dir)).toEqual({});
  });

  it('includes prPrompt from beluga.json', () => {
    touch('beluga.json', JSON.stringify({ prPrompt: 'Link the ticket.' }));
    expect(resolveScripts(dir)).toEqual({ prPrompt: 'Link the ticket.' });
  });

  it('keeps your own PR instructions apart from beluga.json’s', () => {
    touch('beluga.json', JSON.stringify({ prPrompt: 'Link the ticket.' }));
    expect(resolveScripts(dir, { prPrompt: '  Write it in German. ' })).toEqual({ prPrompt: 'Link the ticket.', yourPrPrompt: 'Write it in German.' });
    expect(resolveScripts(dir, { prPrompt: '  ' })).not.toHaveProperty('yourPrPrompt');
  });

  it('ignores an empty prPrompt', () => {
    touch('beluga.json', JSON.stringify({ prPrompt: '' }));
    expect(resolveScripts(dir)).not.toHaveProperty('prPrompt');
  });
});

describe('saveProjectFile', () => {
  const read = () => JSON.parse(readFileSync(path.join(dir, 'beluga.json'), 'utf8')) as Record<string, unknown>;

  it('creates beluga.json with a trailing newline', () => {
    saveProjectFile(dir, { setup: 'npm ci' });
    const text = readFileSync(path.join(dir, 'beluga.json'), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(read()).toEqual({ scripts: { setup: 'npm ci' } });
  });

  it('keeps other fields and existing scripts', () => {
    touch('beluga.json', JSON.stringify({ prPrompt: 'p', other: 1, scripts: { setup: 'old', run: 'keep' } }));
    saveProjectFile(dir, { setup: 'new' });
    expect(read()).toEqual({ prPrompt: 'p', other: 1, scripts: { setup: 'new', run: 'keep' } });
  });

  it('overwrites an unreadable file', () => {
    touch('beluga.json', '{nope');
    saveProjectFile(dir, { run: 'go' });
    expect(read()).toEqual({ scripts: { run: 'go' } });
  });

  it('keeps writing an old klaud.json while it is the only one there (teammates on klaud still read it)', () => {
    touch('klaud.json', JSON.stringify({ prPrompt: 'p', scripts: { run: 'keep' } }));
    expect(saveProjectFile(dir, { setup: 'new' })).toBe('klaud.json');
    expect(JSON.parse(readFileSync(path.join(dir, 'klaud.json'), 'utf8'))).toEqual({ prPrompt: 'p', scripts: { setup: 'new', run: 'keep' } });
    expect(existsSync(path.join(dir, 'beluga.json'))).toBe(false);
    expect(resolveScripts(dir)).toEqual({ setup: { command: 'new', source: 'klaud.json' }, run: { command: 'keep', source: 'klaud.json' }, prPrompt: 'p' });
    // Once a beluga.json is there, it wins.
    touch('beluga.json', JSON.stringify({ scripts: { run: 'b-run' } }));
    expect(resolveScripts(dir).run).toEqual({ command: 'b-run', source: 'beluga.json' });
  });

  it('round-trips through resolveScripts', () => {
    saveProjectFile(dir, { setup: 's', run: 'r' });
    expect(resolveScripts(dir)).toEqual({ setup: { command: 's', source: 'beluga.json' }, run: { command: 'r', source: 'beluga.json' } });
  });
});

describe('scriptEnv', () => {
  it('sets Beluga and conductor variables', () => {
    expect(scriptEnv({ path: '/w', name: 'tokyo', projectRoot: '/p', branch: 'feat/x' })).toEqual({
      BELUGA_WORKSPACE_PATH: '/w',
      BELUGA_WORKSPACE_NAME: 'tokyo',
      BELUGA_ROOT_PATH: '/p',
      BELUGA_BRANCH: 'feat/x',
      // The names from before the rename, for scripts that still read them.
      KLAUD_WORKSPACE_PATH: '/w',
      KLAUD_WORKSPACE_NAME: 'tokyo',
      KLAUD_ROOT_PATH: '/p',
      KLAUD_BRANCH: 'feat/x',
      CONDUCTOR_WORKSPACE_PATH: '/w',
      CONDUCTOR_WORKSPACE_NAME: 'tokyo',
      CONDUCTOR_ROOT_PATH: '/p',
    });
  });

  it('omits BELUGA_BRANCH without a branch', () => {
    expect(Object.keys(scriptEnv({ path: '/w', name: 'n', projectRoot: '/p' })).sort()).toEqual(
      ['BELUGA_ROOT_PATH', 'BELUGA_WORKSPACE_NAME', 'BELUGA_WORKSPACE_PATH', 'CONDUCTOR_ROOT_PATH', 'CONDUCTOR_WORKSPACE_NAME', 'CONDUCTOR_WORKSPACE_PATH', 'KLAUD_ROOT_PATH', 'KLAUD_WORKSPACE_NAME', 'KLAUD_WORKSPACE_PATH'],
    );
  });
});

describe('checkSetup', () => {
  it('skips a JavaScript install where there is no package.json', () => {
    expect(checkSetup(dir, 'yarn')).toMatchObject({ kind: 'skip' });
    expect(checkSetup(dir, 'npm ci')).toMatchObject({ kind: 'skip' });
  });

  it("swaps in the package manager the project's lockfile belongs to", () => {
    pkg({});
    touch('pnpm-lock.yaml');
    expect(checkSetup(dir, 'yarn install')).toEqual({ kind: 'swap', command: 'pnpm install', reason: 'it uses pnpm (pnpm-lock.yaml), not yarn' });
    expect(checkSetup(dir, 'pnpm install --frozen-lockfile')).toEqual({ kind: 'ok' });
  });

  it('runs anything else as written', () => {
    expect(checkSetup(dir, 'yarn && make')).toEqual({ kind: 'ok' });
    expect(checkSetup(dir, 'make setup')).toEqual({ kind: 'ok' });
    pkg({});
    expect(checkSetup(dir, 'yarn')).toEqual({ kind: 'ok' }); // no lockfile: any manager will do
  });

  it('a project learned to need no setup has none, unless you set one', () => {
    touch('yarn.lock');
    expect(resolveScripts(dir, { skipSetup: true }).setup).toBeUndefined();
    expect(resolveScripts(dir, { skipSetup: true, setup: 'make' }).setup).toEqual({ command: 'make', source: 'yours' });
  });
});
