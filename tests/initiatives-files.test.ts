import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSlugs, memoryFiles, readFolder, readMemoryFile, scaffoldFolder } from '../src/core/initiatives/files.js';
import { InitiativeConfigSchema } from '../src/core/initiatives/model.js';
import { commitFolder, ensureRepo, repoRootOf, saveRepoRoot } from '../src/core/initiatives/repo.js';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-initiatives-'));
const config = InitiativeConfigSchema.parse({ name: 'Checkout v2', goal: 'Ship it', epics: ['SHOP-120'] });
const gitLog = (root: string): string[] => execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim().split('\n');

describe('an initiative’s folder', () => {
  it('is scaffolded with its memory files and read back', () => {
    const root = tmp();
    scaffoldFolder(root, 'checkout-v2', config, '2026-11-24');
    const folder = readFolder(root, 'checkout-v2');
    expect(folder.trouble).toBeUndefined();
    expect(folder.config).toMatchObject({ name: 'Checkout v2', epics: ['SHOP-120'], status: 'active' });
    expect(folder.brief).toContain('# Checkout v2');
    expect(folder.suggestions).toEqual([]);
    expect(folder.timeline).toEqual([{ day: '2026-11-24', kind: 'created', text: 'initiative created' }]);
    expect(folder.files).toEqual(['initiative.json', 'brief.md', 'decisions.md', 'timeline.md', 'people.md', 'suggestions.json', 'outbox.json', 'sources/README.md']);
    expect(listSlugs(root)).toEqual(['checkout-v2']);
  });

  it('lists only folders that can be initiatives', () => {
    const root = tmp();
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'Not A Slug'));
    mkdirSync(path.join(root, 'ok-one'));
    writeFileSync(path.join(root, 'README.md'), '#');
    expect(listSlugs(root)).toEqual(['ok-one']);
  });

  it('shows a bad initiative.json as trouble, without throwing', () => {
    const root = tmp();
    scaffoldFolder(root, 'broken', config, '2026-11-24');
    writeFileSync(path.join(root, 'broken', 'initiative.json'), '{ "name": ');
    writeFileSync(path.join(root, 'broken', 'status.json'), '{ "total": "many" }');
    const folder = readFolder(root, 'broken');
    expect(folder.config).toBeUndefined();
    expect(folder.trouble).toMatch(/initiative\.json is not valid JSON/);
    expect(folder.trouble).toMatch(/status\.json/);
    mkdirSync(path.join(root, 'empty'));
    expect(readFolder(root, 'empty').trouble).toBe('initiative.json is missing');
  });

  it('reads tickets.json, and shows a bad one as trouble', () => {
    const root = tmp();
    scaffoldFolder(root, 'one', config, '2026-11-24');
    expect(readFolder(root, 'one').tickets).toBeUndefined();
    writeFileSync(path.join(root, 'one', 'tickets.json'), JSON.stringify({ at: '2026-11-24T08:00:00Z', tickets: [{ key: 'SHOP-1', summary: 'A', status: 'To Do', statusCategory: 'todo', prs: [{ url: 'https://github.com/a/b/pull/1', number: 1, state: 'open' }] }] }));
    const folder = readFolder(root, 'one');
    expect(folder.trouble).toBeUndefined();
    expect(folder.tickets?.tickets[0]).toMatchObject({ key: 'SHOP-1', statusCategory: 'todo', prs: [{ number: 1, state: 'open' }] });
    expect(folder.files).toContain('tickets.json');
    writeFileSync(path.join(root, 'one', 'tickets.json'), '[{ "key": "SHOP-1" }]');
    const bad = readFolder(root, 'one');
    expect(bad.trouble).toMatch(/tickets\.json/);
    expect(bad.tickets).toBeUndefined();
    expect(bad.config).toMatchObject({ name: 'Checkout v2' });
  });

  it('reads an old initiative.json with slackChannels and calendarMatch', () => {
    const root = tmp();
    scaffoldFolder(root, 'old', config, '2026-11-24');
    writeFileSync(path.join(root, 'old', 'initiative.json'), JSON.stringify({ name: 'Old', goal: 'g', status: 'active', epics: [], slackChannels: ['#old'], people: [], calendarMatch: 'Old sync', docs: [], repos: [] }));
    const folder = readFolder(root, 'old');
    expect(folder.trouble).toBeUndefined();
    expect(folder.config).toMatchObject({ slack: [{ ref: '#old' }], meetings: [{ match: 'Old sync' }] });
  });

  it('reads a memory file, and nothing outside the folder', () => {
    const root = tmp();
    scaffoldFolder(root, 'a', config, '2026-11-24');
    writeFileSync(path.join(root, 'secret.txt'), 'no');
    expect(readMemoryFile(root, 'a', 'brief.md').text).toContain('Checkout v2');
    expect(readMemoryFile(root, 'a', 'sources/README.md').name).toBe('sources/README.md');
    expect(() => readMemoryFile(root, 'a', '../secret.txt')).toThrow(/not in the initiative/);
    expect(() => readMemoryFile(root, '../x', 'brief.md')).toThrow();
  });

  it('skips dot files in the memory list', () => {
    const root = tmp();
    scaffoldFolder(root, 'a', config, '2026-11-24');
    mkdirSync(path.join(root, 'a', '.beluga', 'scratch'), { recursive: true });
    writeFileSync(path.join(root, 'a', '.beluga', 'scratch', 'x.txt'), 'x');
    expect(memoryFiles(path.join(root, 'a')).some((f) => f.includes('.beluga'))).toBe(false);
  });
});

describe('the memory repo', () => {
  it('keeps its path in ~/.beluga/initiatives.json, ~/Documents/GitHub/initiatives by default', () => {
    const beluga = tmp();
    expect(repoRootOf(beluga, '/home/k')).toBe(path.join('/home/k', 'Documents/GitHub/initiatives'));
    saveRepoRoot(beluga, '~/notes/initiatives');
    expect(repoRootOf(beluga, '/home/k')).toBe(path.join('/home/k', 'notes/initiatives'));
  });

  it('is made a git repo on first use, and commits one folder at a time', async () => {
    const root = path.join(tmp(), 'initiatives');
    await ensureRepo(root);
    await ensureRepo(root);
    expect(gitLog(root)).toEqual(['Initiatives']);
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('.beluga/');
    scaffoldFolder(root, 'one', config, '2026-11-24');
    scaffoldFolder(root, 'two', config, '2026-11-24');
    expect(await commitFolder(root, 'one', 'one: created')).toBe(true);
    expect(gitLog(root)[0]).toBe('one: created');
    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf8' });
    expect(committed).toContain('one/brief.md');
    expect(committed).not.toContain('two/');
    expect(await commitFolder(root, 'one', 'one: again')).toBe(false);
    writeFileSync(path.join(root, 'one', 'brief.md'), '# changed\n');
    expect(await commitFolder(root, 'one', 'one: check-in 2026-11-24')).toBe(true);
    expect(gitLog(root)[0]).toBe('one: check-in 2026-11-24');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    expect(status).toContain('two/');
  });

  it('pushes each commit when the branch tracks a remote', async () => {
    const remote = path.join(tmp(), 'remote.git');
    execFileSync('git', ['init', '--quiet', '--bare', remote]);
    const root = path.join(tmp(), 'initiatives');
    await ensureRepo(root);
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    execFileSync('git', ['push', '--quiet', '-u', 'origin', 'HEAD'], { cwd: root });
    scaffoldFolder(root, 'one', config, '2026-11-24');
    expect(await commitFolder(root, 'one', 'one: created')).toBe(true);
    expect(gitLog(remote)[0]).toBe('one: created');
  });
});
