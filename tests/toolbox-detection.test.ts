import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { needView } from '../src/companion/open-on-mac.js';
import { waitingNeeds } from '../src/companion/needs-you.js';
import { detectNotices } from '../src/core/notify.js';
import { type DomainState, type ToolboxSuggestion, initialState } from '../src/core/store.js';
import { ToolboxService } from '../src/core/toolbox/service.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { isToolWorthy, toolCommandFrom, toolNameFor } from '../src/workspaces/toolbox.js';
import type { Project, WorkspaceRecord } from '../src/workspaces/types.js';
import { reviewOf } from '../packages/mac/src/layout/waiting-model.js';

const ROOT = '/code/app';
const WT = '/wt/app-feature';

describe('toolCommandFrom', () => {
  it('drops a leading cd into the worktree, with && or ;', () => {
    expect(toolCommandFrom(`cd ${WT} && npm test`, WT, ROOT, '/home/u')).toBe('npm test');
    expect(toolCommandFrom(`cd ${WT}; npm test`, WT, ROOT, '/home/u')).toBe('npm test');
    expect(toolCommandFrom(`cd "${WT}/" && npm test`, WT, ROOT, '/home/u')).toBe('npm test');
  });

  it('drops the ~ form of the cd', () => {
    expect(toolCommandFrom('cd ~/wt/app && npm test', '/home/u/wt/app', ROOT, '/home/u')).toBe('npm test');
  });

  it('reads the worktree path elsewhere as the project', () => {
    expect(toolCommandFrom(`cd ${WT} && node ${WT}/scripts/x.js`, WT, ROOT, '/home/u')).toBe(`node ${ROOT}/scripts/x.js`);
  });

  it('leaves the command alone when cwd is the project root', () => {
    expect(toolCommandFrom(`cd ${ROOT} && npm test`, ROOT, ROOT, '/home/u')).toBe('npm test');
    expect(toolCommandFrom(`node ${ROOT}/x.js`, ROOT, ROOT, '/home/u')).toBe(`node ${ROOT}/x.js`);
  });
});

describe('isToolWorthy', () => {
  it('accepts a plain one-line command', () => {
    expect(isToolWorthy('npm run typecheck')).toBe(true);
  });

  it('rejects here-documents, several lines, too short and too long', () => {
    expect(isToolWorthy("cat <<'EOF' > a.txt")).toBe(false);
    expect(isToolWorthy('echo a\necho b')).toBe(false);
    expect(isToolWorthy('ls')).toBe(false);
    expect(isToolWorthy(`echo ${'x'.repeat(500)}`)).toBe(false);
  });
});

describe('toolNameFor', () => {
  it('takes the first words before a flag or chain', () => {
    expect(toolNameFor('npx vitest run tests/a.test.ts')).toBe('npx vitest run');
    expect(toolNameFor('npm run typecheck --prefix x')).toBe('npm run typecheck');
    expect(toolNameFor('FOO=1 npm test')).toBe('npm test');
    expect(toolNameFor('bash scripts/x.sh && y')).toBe('bash scripts/x.sh');
  });

  it('is at most 40 characters', () => {
    expect(toolNameFor(`bash ${'a'.repeat(80)}`).length).toBeLessThanOrEqual(40);
  });
});

const record = (over: Partial<WorkspaceRecord>): WorkspaceRecord => ({ id: 'w1', projectRoot: ROOT, name: 'feature', path: WT, kind: 'worktree', createdAt: 1, ...over });

describe('ToolboxService detection', () => {
  let home: string;
  let store: WorkspaceStore;
  let service: ToolboxService;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'toolbox-detect-'));
    store = new WorkspaceStore(path.join(home, 'home'));
    store.saveRecords([record({})]);
    service = new ToolboxService({ store });
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('counts a worktree command for its project and offers it on the third run', () => {
    const command = `cd ${WT} && npx vitest run tests/a.test.ts`;
    expect(service.recordBashCommand(WT, command)).toBeUndefined();
    expect(service.recordBashCommand(WT, command)).toBeUndefined();
    const sig = service.recordBashCommand(WT, command);
    expect(sig?.projectRoot).toBe(ROOT);
    expect(sig?.run).toBe('npx vitest run tests/a.test.ts');
    expect(sig?.name).toBe('npx vitest run');
    expect(sig?.count).toBe(3);
  });

  it('maps a worktree folder to the project, and an unknown folder to itself', () => {
    expect(service.projectRootOf(WT)).toBe(ROOT);
    expect(service.projectRootOf('/elsewhere')).toBe('/elsewhere');
  });

  it('never offers a heredoc', () => {
    const command = "cat <<'EOF' > notes.txt";
    const results = [1, 2, 3, 4].map(() => service.recordBashCommand(WT, command));
    expect(results.every((r) => r === undefined)).toBe(true);
  });

  it('never offers a command that is already a tool', () => {
    service.create(ROOT, { name: 'Test', command: 'npm run test:unit' });
    const results = [1, 2, 3, 4].map(() => service.recordBashCommand(WT, `cd ${WT} && npm run test:unit`));
    expect(results.every((r) => r === undefined)).toBe(true);
  });

  it('adoptStrays moves tools from a worktree key to the project, once per command', () => {
    service.create(WT, { name: 'Dup', command: 'npm test' });
    service.create(WT, { name: 'Lint', command: 'npm run lint' });
    service.create(ROOT, { name: 'Test', command: 'npm test' });
    expect(service.adoptStrays()).toBe(1);
    expect(service.listPersonal(WT)).toEqual([]);
    expect(service.listPersonal(ROOT).map((t) => t.command)).toEqual(['npm test', 'npm run lint']);
    expect(service.adoptStrays()).toBe(0);
  });
});

const project: Project = { id: 'p1', name: 'App', root: ROOT, base: 'origin/main', workspaces: [] };

const detection = (extra: Partial<ToolboxSuggestion> = {}): ToolboxSuggestion => ({ id: 'sig1', kind: 'detection', projectRoot: ROOT, name: 'npx vitest run', command: 'npx vitest run tests/a.test.ts', count: 3, askedAt: 1000, ...extra });

const stateWith = (suggestions: readonly ToolboxSuggestion[]): DomainState => ({ ...initialState('room'), projects: [project], toolboxSuggestions: suggestions });

describe('a detected Toolbox tool on the phone and Mac', () => {
  it('names the tool and the project, and carries the command', () => {
    const [item] = waitingNeeds(stateWith([detection()])).filter((n) => n.id === 'toolbox-detect:sig1');
    expect(item?.title).toBe('Make "npx vitest run" a tool in App\'s Toolbox? (run 3×)');
    expect(item?.detail).toBe('npx vitest run tests/a.test.ts');
  });

  it('opens the project', () => {
    expect(needView(stateWith([detection()]), 'toolbox-detect:sig1')).toEqual({ kind: 'project', id: 'p1' });
    expect(needView(stateWith([detection({ id: 'propose-1', kind: 'propose' })]), 'toolbox-propose:propose-1')).toEqual({ kind: 'project', id: 'p1' });
    expect(needView(stateWith([]), 'toolbox-detect:gone')).toBeUndefined();
  });

  it('raises a notice when a suggestion is added, and not again for the same one', () => {
    const prev = stateWith([]);
    const next = stateWith([detection()]);
    const notices = detectNotices(prev, next);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'needsYou', need: 'toolbox-detect:sig1', key: 'toolbox:sig1:1000' });
    expect(detectNotices(next, { ...next, toolboxSuggestions: [...next.toolboxSuggestions] })).toEqual([]);
  });
});

describe('reviewOf', () => {
  it('gives the detail of a Toolbox request only', () => {
    expect(reviewOf({ id: 'toolbox-detect:x', detail: 'npm test' })).toBe('npm test');
    expect(reviewOf({ id: 'toolbox-propose:x', detail: 'npm test' })).toBe('npm test');
    expect(reviewOf({ id: 'team:x', detail: 'npm test' })).toBeUndefined();
    expect(reviewOf({ id: 'toolbox-detect:x' })).toBeUndefined();
  });
});
