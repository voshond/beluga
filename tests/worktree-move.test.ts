import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type LogItem, Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { worktreeMover } from '../src/core/worktree-move.js';
import { API } from '../src/ipc/api.js';
import { MoveAsk, type MoveCaller } from '../src/machines/move-plan.js';
import { continueOn } from '../src/machines/move.js';
import type { Workspace, WorkspaceRecord } from '../src/workspaces/types.js';

/** BLG-808: Continue On moves a worktree with its branch and its conversation, asking about uncommitted changes. */

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();

/** A computer: a project (a real repo without an origin), its worktrees, their saved conversations. */
function computer(name: string) {
  const root = mkdtempSync(path.join(tmpdir(), `move-${name}-`));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'start');
  const store = new Store(initialState('room'));
  const workspaces: Workspace[] = [];
  const publish = (): void => store.dispatch({ type: 'projects', projects: [{ id: 'p', name: 'bob-api', root, base: 'main', workspaces: [...workspaces] }] });
  publish();
  const histories = new Map<string, readonly unknown[]>();
  let n = 0;
  const add = (ws: Partial<WorkspaceRecord> & { name: string; branch: string; path: string }): Workspace => {
    const w = { id: `${name}-w${++n}`, projectId: 'p', projectRoot: root, kind: 'worktree', createdAt: 0, external: false, ...ws } as unknown as Workspace;
    workspaces.push(w);
    publish();
    return w;
  };
  const patch = (id: string, p: Partial<WorkspaceRecord>): void => {
    const i = workspaces.findIndex((w) => w.id === id);
    workspaces[i] = { ...workspaces[i]!, ...p } as Workspace;
    publish();
  };
  const controller = {
    manager: {
      find: (id: string) => workspaces.find((w) => w.id === id),
      loadHistory: (id: string) => histories.get(id) ?? [],
      saveHistory: (id: string, items: readonly unknown[]) => void histories.set(id, items),
      createWorktreeOn: async (_p: string, wsName: string, branch: string, extra: Partial<WorkspaceRecord>) => {
        const dir = path.join(root, '..', `${path.basename(root)}-${wsName}-${n + 1}`);
        dirs.push(dir);
        git(root, 'worktree', 'add', '-q', dir, branch);
        return add({ name: wsName, branch, path: dir, ...extra });
      },
      markContinuedOn: (id: string, to: string) => patch(id, { continuedOn: to }),
    },
    archive: async (id: string) => (patch(id, { archived: true }), true),
    refresh: async () => undefined,
  } as unknown as WorkspaceController;
  /** A worktree here on beluga/<wsName> with one commit, and what was said in it. */
  const worktree = (wsName: string): Workspace => {
    const dir = path.join(root, '..', `${path.basename(root)}-${wsName}`);
    dirs.push(dir);
    git(root, 'worktree', 'add', '-q', '-b', `beluga/${wsName}`, dir);
    writeFileSync(path.join(dir, 'lexer.ts'), 'export const lex = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'lexer');
    const w = add({ name: wsName, branch: `beluga/${wsName}`, path: dir });
    histories.set(w.id, [
      { id: 'h1', type: 'chat', channel: `ws:${w.id}`, from: 'p-me', name: 'Kay', text: 'write the lexer', ts: 1, byAgent: false },
      { id: 'h2', type: 'chat', channel: `ws:${w.id}`, from: 'p-me', name: 'Claude', text: 'Lexer done.', ts: 2, byAgent: true },
    ]);
    return w;
  };
  const session = { store, workspaces: controller };
  const caller: MoveCaller & { fail?: string } = {
    async call(method: string, ...args: unknown[]) {
      if (caller.fail === method) throw new Error(`${method} failed`);
      const parsed = API[method as keyof typeof API].args.parse(args) as unknown[];
      const m = worktreeMover(store, controller);
      const fn = { 'workspaces.moveCheck': m.check, 'workspaces.movePack': m.packOut, 'workspaces.moveChunk': m.chunk, 'workspaces.moveReceive': m.receive, 'workspaces.moveLand': m.landIn, 'workspaces.moveDone': m.done, 'workspaces.moveUndo': m.undo }[method] as ((...a: unknown[]) => unknown) | undefined;
      if (!fn) throw new Error(`not faked: ${method}`);
      return fn.apply(m, parsed);
    },
  };
  return { root, store, workspaces, histories, caller, worktree, session };
}

const go = (a: ReturnType<typeof computer>, b: ReturnType<typeof computer>, id: string, extra: Partial<Parameters<typeof continueOn>[0]> = {}) =>
  continueOn({ from: a.caller, to: b.caller, workspaceId: id, fromPlace: { name: 'This Mac' }, toPlace: { id: '0123456789abcdef', name: 'build-box' }, projectThere: async () => 'p', sleep: async () => undefined, ...extra });

describe('Continue On another computer (BLG-808)', () => {
  it('moves a worktree with its branch and its conversation; the old one is archived only after', async () => {
    const a = computer('mac');
    const b = computer('box');
    const ws = a.worktree('lexer');
    const made = await go(a, b, ws.id);
    const there = b.workspaces.find((w) => w.id === made)!;
    expect(there).toMatchObject({ branch: 'beluga/lexer', continuedFrom: 'This Mac', carryFrom: 'your agent on This Mac' });
    expect(git(there.path, 'log', '-1', '--format=%s')).toBe('lexer');
    const said = b.histories.get(made) as LogItem[];
    expect(said.filter((l) => l.type === 'chat').map((l) => (l as { text: string }).text)).toEqual(['write the lexer', 'Lexer done.']);
    expect(said.every((l) => l.channel === `ws:${made}`)).toBe(true);
    expect(a.workspaces.find((w) => w.id === ws.id)).toMatchObject({ archived: true, continuedOn: 'build-box' });
  });

  it('asks about changes not committed, and commits them only when you say so', async () => {
    const a = computer('mac');
    const b = computer('box');
    const ws = a.worktree('parser');
    writeFileSync(path.join(ws.path, 'parser.ts'), 'export const parse = 2;\n');
    const asked = await go(a, b, ws.id).catch((e: unknown) => e);
    expect(asked).toBeInstanceOf(MoveAsk);
    expect((asked as MoveAsk).items).toEqual(['parser.ts']);
    // Nothing happened: not committed, not archived, nothing there.
    expect(git(ws.path, 'status', '--porcelain')).toBe('?? parser.ts');
    expect(a.workspaces.find((w) => w.id === ws.id)?.archived).toBeUndefined();
    expect(b.workspaces).toEqual([]);

    const made = await go(a, b, ws.id, { commit: true });
    const there = b.workspaces.find((w) => w.id === made)!;
    expect(git(there.path, 'show', 'HEAD:parser.ts')).toBe('export const parse = 2;');
    expect(git(there.path, 'log', '-1', '--format=%s')).toMatch(/before continuing on build-box/);
  });

  it('waits for its agent’s turn when you say so (asked first)', async () => {
    const a = computer('mac');
    const b = computer('box');
    const ws = a.worktree('busy');
    let checks = 0;
    const busyFirst: MoveCaller = { call: async (m: string, ...args: unknown[]) => { const r = await a.caller.call(m, ...args); return m === 'workspaces.moveCheck' && checks++ < 1 ? { ...(r as object), busy: true } : r; } };
    const asked = await continueOn({ from: busyFirst, to: b.caller, workspaceId: ws.id, fromPlace: { name: 'This Mac' }, toPlace: { name: 'build-box' }, projectThere: async () => 'p' }).catch((e: unknown) => e);
    expect((asked as MoveAsk).kind).toBe('running');
    checks = 0;
    await continueOn({ from: busyFirst, to: b.caller, workspaceId: ws.id, fromPlace: { name: 'This Mac' }, toPlace: { name: 'build-box' }, projectThere: async () => 'p', wait: true, sleep: async () => undefined });
    expect(b.workspaces).toHaveLength(1);
  });

  it('a move that fails leaves the worktree where it was; one whose old one can’t be archived is archived there again', async () => {
    const a = computer('mac');
    const b = computer('box');
    const ws = a.worktree('safe');
    await expect(go(a, b, ws.id, { projectThere: async () => 'missing' })).rejects.toThrow(/project isn’t here/);
    expect(a.workspaces.find((w) => w.id === ws.id)?.archived).toBeUndefined();
    expect(b.workspaces).toEqual([]);
    expect(git(b.root, 'branch', '--list', 'beluga/safe')).toBe('');

    a.caller.fail = 'workspaces.moveDone';
    await expect(go(a, b, ws.id)).rejects.toThrow(/moveDone failed/);
    expect(a.workspaces.find((w) => w.id === ws.id)?.archived).toBeUndefined();
    expect(b.workspaces.every((w) => w.archived)).toBe(true);
  });
});
