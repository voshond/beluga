import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../src/net/crypto.js';
import { type Lease, type LeaseBoard, type LeaseHost, LeaseKeeper, TAKEOVER_MS } from '../src/machines/lease.js';

/** The lease (BLG-799): renewed by whichever install is you; a stand-in only after 10 minutes down; never two at once. */

const me = generateIdentity();
const MAC = 'aaaaaaaaaaaaaaaa';
const MINI = 'bbbbbbbbbbbbbbbb';
const MIN = 60_000;

function memoryBoard(): LeaseBoard & { lease?: Lease; reads: number } {
  const board = {
    lease: undefined as Lease | undefined,
    reads: 0,
    read: async () => {
      board.reads++;
      return board.lease;
    },
    write: async (_: unknown, lease: Omit<Lease, 'seq'>, seq: number) => {
      if (board.lease && seq <= board.lease.seq) throw new Error('older seq');
      board.lease = { ...lease, seq };
    },
  };
  return board;
}

function setup(state: { holding: boolean; at?: string; standingIn?: { id: string; name: string }; canStandIn?: boolean; involved?: boolean }) {
  let now = 1_700_000_000_000;
  const calls: string[] = [];
  const host: LeaseHost = {
    involved: () => state.involved ?? true,
    holding: () => state.holding,
    standingIn: () => state.standingIn,
    at: () => state.at,
    leaseIdentity: () => me,
    canStandIn: () => state.canStandIn ?? true,
    standIn: async () => {
      calls.push('standIn');
      state.holding = true;
      state.at = undefined;
    },
    standDown: async (h) => {
      calls.push(`standDown:${h.name}`);
      state.holding = false;
      state.at = h.id;
    },
    handBack: async () => void calls.push('handBack'),
    refreshStandby: async () => (calls.push('replica'), true),
  };
  const board = memoryBoard();
  const heard = new Map<string, number>();
  let answers = false;
  const keeper = new LeaseKeeper({ host, board, self: () => ({ id: MAC, name: 'MacBook' }), heard: (id) => heard.get(id), reachable: async () => answers, now: () => now });
  return {
    keeper,
    board,
    calls,
    heard,
    state,
    advance: (ms: number) => (now += ms),
    now: () => now,
    answers: (yes: boolean) => void (answers = yes),
  };
}

describe('the lease', () => {
  it('whoever is you renews it every round', async () => {
    const t = setup({ holding: true });
    await t.keeper.tick();
    expect(t.board.lease).toMatchObject({ holder: MAC, name: 'MacBook', seq: 1 });
    t.advance(MIN);
    await t.keeper.tick();
    expect(t.board.lease).toMatchObject({ holder: MAC, seq: 2, at: t.now() });
  });

  it('a holder that finds a newer you elsewhere stops at once: never two of you', async () => {
    const t = setup({ holding: true });
    t.board.lease = { v: 1, holder: MINI, name: 'Mac mini', at: t.now(), seq: 7 };
    await t.keeper.tick();
    expect(t.calls).toEqual(['standDown:Mac mini']);
    expect(t.board.lease.holder).toBe(MINI);
  });

  it('while your Always On answers, this Mac only keeps its replica fresh', async () => {
    const t = setup({ holding: false, at: MINI });
    t.board.lease = { v: 1, holder: MINI, name: 'Mac mini', at: t.now(), seq: 3 };
    t.heard.set(MINI, t.now());
    await t.keeper.tick();
    expect(t.calls).toEqual(['replica']);
    // Not again before ten minutes.
    t.advance(MIN);
    t.heard.set(MINI, t.now());
    await t.keeper.tick();
    expect(t.calls).toEqual(['replica']);
  });

  it('stands in only after 10 minutes of silence with its lease gone stale, then holds the lease itself', async () => {
    const t = setup({ holding: false, at: MINI });
    t.board.lease = { v: 1, holder: MINI, name: 'Mac mini', at: t.now(), seq: 3 };
    t.heard.set(MINI, t.now());
    // 9 minutes of silence, lease 9 minutes old: still waiting.
    t.advance(9 * MIN);
    await t.keeper.tick();
    expect(t.calls).not.toContain('standIn');
    t.advance(2 * MIN);
    await t.keeper.tick();
    expect(t.calls).toContain('standIn');
    expect(t.board.lease).toMatchObject({ holder: MAC, seq: 4 });
  });

  it('never stands in while the lease is still renewed, or when one last try reaches it', async () => {
    const t = setup({ holding: false, at: MINI });
    t.advance(TAKEOVER_MS + MIN);
    t.board.lease = { v: 1, holder: MINI, name: 'Mac mini', at: t.now() - MIN, seq: 3 };
    await t.keeper.tick();
    expect(t.calls).toEqual([]);
    t.board.lease = { ...t.board.lease, at: t.now() - TAKEOVER_MS - MIN };
    t.answers(true);
    await t.keeper.tick();
    expect(t.calls).toEqual([]);
  });

  it('with the DHT out of reach, 10 minutes unheard since this Mac opened is enough', async () => {
    const t = setup({ holding: false, at: MINI });
    t.board.read = async () => undefined;
    await t.keeper.tick();
    expect(t.calls).toEqual([]);
    t.advance(TAKEOVER_MS);
    await t.keeper.tick();
    expect(t.calls).toEqual(['standIn']);
  });

  it('standing in, it hands back as soon as your Always On answers', async () => {
    const t = setup({ holding: true, standingIn: { id: MINI, name: 'Mac mini' } });
    await t.keeper.tick();
    expect(t.calls).toEqual([]);
    t.answers(true);
    await t.keeper.tick();
    expect(t.calls).toEqual(['handBack']);
  });

  it('an install that was your Always On asks first when it starts, and waits while another one is you', async () => {
    const t = setup({ holding: true });
    t.board.lease = { v: 1, holder: MINI, name: 'Mac mini', at: t.now(), seq: 2 };
    expect(await t.keeper.mayRun()).toMatch(/Mac mini is you on the network right now/);
    expect(t.calls).toEqual(['standDown:Mac mini']);
    // Its own lease, or a stale one: it may run.
    const u = setup({ holding: true });
    u.board.lease = { v: 1, holder: MINI, name: 'Mac mini', at: u.now() - TAKEOVER_MS - 1, seq: 2 };
    expect(await u.keeper.mayRun()).toBeUndefined();
  });

  it('installs that never had an Always On never touch the lease (no DHT asked)', async () => {
    const t = setup({ holding: true, involved: false });
    expect(await t.keeper.mayRun()).toBeUndefined();
    await t.keeper.tick();
    expect(t.board.reads).toBe(0);
    expect(t.board.lease).toBeUndefined();
  });
});

describe('the lease on the DHT', () => {
  it('is written and read under your identity’s key, newest first, and nobody else’s key reads it', async () => {
    const { default: createTestnet } = await import('hyperdht/testnet.js');
    const { dhtLeaseBoard } = await import('../src/machines/lease.js');
    const testnet = await createTestnet(3);
    try {
      const writer = dhtLeaseBoard(async () => testnet.nodes[0]!);
      const reader = dhtLeaseBoard(async () => testnet.nodes[2]!);
      await writer.write(me, { v: 1, holder: MINI, name: 'Mac mini', at: 1 }, 1);
      await writer.write(me, { v: 1, holder: MAC, name: 'MacBook', at: 2 }, 2);
      expect(await reader.read(me)).toEqual({ v: 1, holder: MAC, name: 'MacBook', at: 2, seq: 2 });
      expect(await reader.read(generateIdentity())).toBeUndefined();
    } finally {
      await testnet.destroy();
    }
  }, 30_000);
});
