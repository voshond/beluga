import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { decideTool } from '../src/agent/policy.js';
import { AgentHost } from '../src/core/agent-host.js';
import { Board } from '../src/core/board/board.js';
import { actorName } from '../src/core/board/model.js';
import { BoardWork } from '../src/core/board/work.js';
import { ActorSchema } from '../src/core/team/protocol.js';
import { Store, initialState } from '../src/core/store.js';
import type { TrustLevel } from '../src/core/trust.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { waitFor } from './helpers.js';

/**
 * BLG-701: a friend you trust can use your task board through your Claude, as their trust allows.
 * Full trust: freely, like you. Trusted: looks freely, changes ask you. Ask me each time: all of it
 * asks. Blocked, or a guest invited by link: no board. A friend reaching you through the friends
 * network (a shared worktree's chat) is never a room peer: their saved trust counts all the same.
 */

const ME = 'p-me';
const BRAN = 'p-bran';
const TREE = 'ws:w1';

function hostSetup(trust: TrustLevel | undefined, opts: { guest?: boolean } = {}) {
  const store = new Store(initialState('room', 'ask'));
  store.dispatch({ type: 'welcome', self: { peerId: ME, name: 'Kayra', agent: true, shares: [] } });
  // Saved on an earlier day, never in the room: only `remembered` knows them.
  if (trust) store.dispatch({ type: 'remembered', people: { [BRAN]: { name: 'Bran', trust } } });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-friend-board-'));
  const runs: AgentRunInput[] = [];
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      runs.push(input);
      return 'ok';
    },
  };
  const boards: Array<{ from: string; friend?: { id: string; name: string } }> = [];
  const host = new AgentHost({
    store,
    selfId: () => ME,
    send: () => true,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    workspaces: { place: () => ({ cwd: dir, additionalDirectories: [], autoEdit: true, onSession: () => undefined }), refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
    board: (channel, from, o) => {
      boards.push({ from, ...(o.friend ? { friend: o.friend } : {}) });
      return from === ME || o.friend ? { tools: { channel } as never, brief: 'board' } : undefined;
    },
    isGuest: () => Boolean(opts.guest),
  });
  const ask = async (from = BRAN): Promise<AgentRunInput | undefined> => {
    const before = runs.length;
    await host.onAgentRequest(from, { kind: 'agent_request', requestId: `r-${from}-${before}`, prompt: 'open a task', viaAgent: false, channel: TREE, urgent: false, plan: false });
    await waitFor(() => runs.length > before, 500).catch(() => undefined);
    return runs.length > before ? runs.at(-1) : undefined;
  };
  return { store, ask, boards };
}

describe('a friend’s run and your board (BLG-701)', () => {
  it('Full trust saved for a friend outside the room: the board, nothing asks', async () => {
    const t = hostSetup('full');
    const run = (await t.ask())!;
    expect(run.board).toBeDefined();
    expect(run.boardAsks).toBeUndefined();
    expect(t.boards.at(-1)).toEqual({ from: BRAN, friend: { id: BRAN, name: 'Bran' } });
    // A command in their run runs without asking you (it asked before: they read as "Ask me each time").
    expect(await run.canUseTool('Bash', { command: 'npm test' })).toBe(true);
    expect(t.store.getState().approvals).toHaveLength(0);
    expect(run.scope).toBe('full');
  });

  it('Trusted: the board, and its changes ask you', async () => {
    const run = (await hostSetup('trusted').ask())!;
    expect(run.board).toBeDefined();
    expect(run.boardAsks).toBe('writes');
  });

  it('Ask me each time: the board, and every use of it asks you', async () => {
    const run = (await hostSetup('ask').ask())!;
    expect(run.boardAsks).toBe('all');
  });

  it('a guest invited by link gets no board, whatever their level', async () => {
    const run = (await hostSetup('full', { guest: true }).ask())!;
    expect(run.board).toBeUndefined();
  });

  it('your own runs are as before', async () => {
    const t = hostSetup('full');
    const run = (await t.ask(ME))!;
    expect(run.board).toBeDefined();
    expect(t.boards.at(-1)).toEqual({ from: ME });
  });
});

describe('the policy for a friend’s board tools', () => {
  const ctx = { cwd: '/tmp/w', roots: ['/tmp/w'], autoEdit: true };
  const list = 'mcp__beluga_board__task_list';
  const create = 'mcp__beluga_board__task_create';
  it('runs them for you and Full trust, asks for changes when Trusted, asks for all at Ask me', () => {
    expect([decideTool(list, {}, ctx), decideTool(create, {}, ctx)]).toEqual(['allow', 'allow']);
    expect([decideTool(list, {}, { ...ctx, boardAsks: 'writes' }), decideTool(create, {}, { ...ctx, boardAsks: 'writes' })]).toEqual(['allow', 'ask']);
    expect([decideTool(list, {}, { ...ctx, boardAsks: 'all' }), decideTool(create, {}, { ...ctx, boardAsks: 'all' })]).toEqual(['ask', 'ask']);
    // Other tools are untouched.
    expect(decideTool('TodoWrite', {}, { ...ctx, boardAsks: 'all' })).toBe('allow');
  });
});

const ws = (id: string, projectId: string, name: string): Workspace => ({ id, projectId, name, path: `/tmp/${name}`, kind: 'worktree', projectRoot: '/tmp/p', branch: `beluga/${name}`, createdAt: 0, external: false }) as unknown as Workspace;
const project = (id: string, name: string, workspaces: Workspace[] = []): Project => ({ id, name, root: `/tmp/${name}`, base: 'main', workspaces });

function boardSetup() {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [project('beluga', 'beluga', [ws('w1', 'beluga', 'emoji')]), project('other', 'other')] });
  const board = new Board({ store, dir: null, projectName: (id) => store.getState().projects.find((p) => p.id === id)?.name });
  const work = new BoardWork({ store, board, selfId: () => ME, selfName: () => 'Kayra', askClaude: () => undefined });
  const mine = board.create({ projectId: 'beluga', title: 'Reactions', status: 'todo' }, work.me());
  const secret = board.create({ projectId: 'beluga', title: 'Surprise for Bran', status: 'todo', private: true }, work.me());
  const elsewhere = board.create({ projectId: 'other', title: 'Other repo', status: 'todo' }, work.me());
  const tools = work.forRun(TREE, BRAN, { friend: { id: BRAN, name: 'Bran' } })!.tools!;
  return { board, work, tools, mine, secret, elsewhere };
}

describe('the board a friend’s run reaches', () => {
  it('needs the friend named: a friend’s run without it has none', () => {
    const { work } = boardSetup();
    expect(work.forRun(TREE, BRAN)).toBeUndefined();
    expect(work.forRun(TREE, BRAN, { friend: { id: 'p-someone-else', name: 'X' } })).toBeUndefined();
  });

  it('opens a task on this repo’s board, recorded as your Claude for them', () => {
    const { board, tools } = boardSetup();
    const said = tools.create({ title: 'Emoji reactions', goal: 'React like Slack' });
    expect(said).toMatch(/^Created BLG-\d+|^Created \w+-\d+/);
    const made = board.state().issues.find((i) => i.title === 'Emoji reactions')!;
    expect(made.projectId).toBe('beluga');
    const by = made.activity[0]!.by;
    expect(by).toMatchObject({ kind: 'claude', owner: ME, for: { id: BRAN, name: 'Bran' } });
    expect(actorName(by, ME)).toBe('Your Claude, for Bran');
    expect(actorName(by, BRAN)).toBe("Kayra's Claude, for you");
  });

  it('lists and reads this board only, never a private task', () => {
    const { tools, mine, secret, elsewhere } = boardSetup();
    const listed = tools.list({ scope: 'all' });
    expect(listed).toContain(mine.key);
    expect(listed).not.toContain(secret.key);
    expect(listed).not.toContain(elsewhere.key);
    expect(() => tools.get(secret.key)).toThrow(/only use this repo's board/);
    expect(() => tools.get(elsewhere.key)).toThrow(/only use this repo's board/);
    expect(() => tools.list({ project: 'other' })).toThrow(/only use this repo's board/);
  });

  it('can’t reach another repo, make a board, a private task or define the conversation’s own', () => {
    const { tools, mine, elsewhere } = boardSetup();
    expect(() => tools.create({ title: 'x', project: 'other' })).toThrow(/only use this repo's board/);
    expect(() => tools.create({ title: 'x', private: true })).toThrow(/private/);
    expect(() => tools.createBoard({ name: 'Mine now', repos: ['beluga'] })).toThrow(/new board/);
    expect(() => tools.define({ title: 'x', goal: 'y' })).toThrow(/owner/);
    expect(() => tools.note(elsewhere.key, 'hi')).toThrow(/only use this repo's board/);
    expect(() => tools.relate(mine.key, 'blocked_by', elsewhere.key)).toThrow(/only use this repo's board/);
    expect(() => tools.update(mine.key, { project: 'other' })).toThrow(/another repo/);
    expect(tools.note(mine.key, 'Bran was here')).toMatch(/^Noted on/);
  });

  it('teammates’ boards carry who it was for; a bad one is dropped, not the line', () => {
    const peer = 'a'.repeat(32);
    expect(ActorSchema.parse({ kind: 'claude', owner: peer, ownerName: 'Kayra', for: { id: 'b'.repeat(32), name: 'Bran' } })).toMatchObject({ for: { name: 'Bran' } });
    expect(ActorSchema.parse({ kind: 'claude', owner: peer, ownerName: 'Kayra', for: { id: 3 } })).toEqual({ kind: 'claude', owner: peer, ownerName: 'Kayra' });
  });
});
