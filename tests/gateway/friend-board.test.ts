import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardTools } from '../../src/agent/types.js';
import type { TrustLevel } from '../../src/core/trust.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { node, task } from './helpers.js';

/**
 * BLG-701: a friend's request by DM (ask_person) to work in one of your projects gets that
 * project's task board, when you trust them: Full trust freely, Trusted with each change asking
 * you. A request in a scratch folder, or from someone on "Ask me each time", gets none.
 */

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

let n = 0;
async function ask(level: TrustLevel, project?: string) {
  n++;
  const root = mkdtempSync(path.join(os.tmpdir(), 'beluga-gw-board-'));
  const boards: Array<{ project: string; friend: { id: string; name: string } }> = [];
  const kay = await node(net, `kay${n}`, {
    projectRoot: (name) => (name === 'beluga' ? root : undefined),
    projects: () => ['beluga'],
    board: (p, friend) => (boards.push({ project: p, friend }), { tools: { current: undefined } as unknown as BoardTools, brief: 'the board' }),
  });
  const bran = await node(net, `bran${n}`);
  await befriend(kay.person, bran.person);
  kay.trust(bran.id, level);
  bran.trust(kay.id, 'trusted');
  const t = bran.gw.ask({ person: `kay${n}`, ask: 'open a task for emoji reactions', by: 'agent', ...(project ? { project, needs: ['project'] } : {}) });
  await settle(() => kay.approvals.length > 0 || kay.claude.runs.length > 0);
  if (!kay.claude.runs.length) {
    kay.approvals[0]!.answer('yes');
    await settle(() => kay.claude.runs.length > 0);
  }
  await settle(() => task(bran, t.id)?.state === 'done');
  return { run: kay.claude.runs[0]!, boards, kay, bran };
}

describe('a friend’s DM request in your project and your board (BLG-701)', () => {
  it('Full trust: the board, freely, recorded for them', async () => {
    const { run, boards, bran } = await ask('full', 'beluga');
    expect(run.board).toBeDefined();
    expect(run.taskBrief).toBe('the board');
    expect(run.boardAsks).toBeUndefined();
    expect(boards).toEqual([{ project: 'beluga', friend: { id: bran.id, name: expect.any(String) } }]);
  }, 30_000);

  it('Trusted: the board, and its changes ask you', async () => {
    const { run } = await ask('trusted', 'beluga');
    expect(run.board).toBeDefined();
    expect(run.boardAsks).toBe('writes');
  }, 30_000);

  it('no project named (a scratch folder): no board', async () => {
    const { run, boards } = await ask('full');
    expect(run.board).toBeUndefined();
    expect(boards).toHaveLength(0);
  }, 30_000);
});
