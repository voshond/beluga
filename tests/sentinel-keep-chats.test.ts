import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MacAssistant } from '../src/core/assistant/assistant.js';
import { pretendSystem } from '../src/core/gateway/demo-system.js';
import { ALWAYS_ASK_YOU } from '../src/agent/policy.js';
import { SentinelChats } from '../src/core/sentinel/chat.js';
import { CLAUDE_CHANGED, type RunSummary, type Sentinel, keepsChat, sentinelChatChannel } from '../src/core/sentinel/model.js';
import { needsALook, sidebarSentinels } from '../packages/mac/src/sentinel/sentinel-model.js';
import type { SentinelPlaces } from '../src/core/sentinel/runner.js';
import { ToolDraftSchema, ToolPatchSchema } from '../src/core/sentinel/tool-draft.js';
import { fromToolDraft } from '../src/core/sentinel/sentinels.js';
import { Store, initialState } from '../src/core/store.js';
import type { AgentRef } from '../src/protocol.js';
import { tabChats } from '../src/shared/assistant.js';
import { type Asked, fakePlaces, setup, until } from './sentinel-fakes.js';

/**
 * BLG-566: an hourly sentinel stopped on its 30th run, because each run opened a Your Mac chat and
 * Open chats (30) refused the next. A run's chat is its run's now: not a tab, not counted, and each
 * sentinel keeps the runs' chats it's told to (every run, failed runs only, the latest only).
 */

const CODEX: AgentRef = { runtime: 'codex', label: 'Codex', model: 'gpt-5.5' };
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-keep-chats-'));

function store(chatLimit: number): Store {
  const s = new Store(initialState('room', 'auto'));
  s.dispatch({ type: 'identity', selfId: 'me', isHost: true, home: '/Users/k' });
  s.dispatch({ type: 'prefs', prefs: { chatLimit } });
  return s;
}

const mac = (s: Store, dir = tmp()): MacAssistant => new MacAssistant({ store: s, dir, selfId: () => 'me', system: pretendSystem(), claudeDir: tmp() });

describe('Your Mac: a sentinel run’s chat', () => {
  it('is never refused by Open chats, nor counted against yours', () => {
    const s = store(30);
    const m = mac(s);
    for (let i = 0; i < 45; i++) m.newChat({ auto: true });
    // 29 of your own still fit beside the first.
    for (let i = 0; i < 29; i++) m.newChat();
    expect(() => m.newChat()).toThrow(/30 Your Mac chats are open/);
  });

  it('leaves the chat you have open, open, and isn’t a tab unless it is the open one', () => {
    const s = store(30);
    const m = mac(s);
    const mine = m.newChat();
    const run = m.newChat({ auto: true });
    const chats = s.getState().assistant;
    expect(chats.active).toBe(mine);
    expect(chats.chats.find((c) => c.id === run)?.auto).toBe(true);
    expect(tabChats(chats).map((c) => c.id)).not.toContain(run);
    m.openChat(run);
    expect(tabChats(s.getState().assistant).map((c) => c.id)).toContain(run);
  });

  it('runs on the agent its step chose, and remembers it across a restart', () => {
    const dir = tmp();
    const s = store(30);
    const id = mac(s, dir).newChat({ auto: true, agent: CODEX });
    const again = mac(store(30), dir);
    expect(again.place(`mac:assistant:${id}`).agent).toEqual(CODEX);
    expect(again.chats().chats.find((c) => c.id === id)?.auto).toBe(true);
    // Your own chats run your default.
    expect(again.place(`mac:assistant:${again.newChat()}`).agent?.runtime).toBe('claude');
  });
});

describe('keepsChat', () => {
  const run = (id: string, state: 'done' | 'failed' | 'stopped' | 'running' | 'needs-you') => ({ id, state });
  it('every run; failed (and stopped) only; the latest only; never one still going', () => {
    expect(keepsChat('all', run('a', 'done'), 'b')).toBe(true);
    expect(keepsChat('failed', run('a', 'done'), 'a')).toBe(false);
    expect(keepsChat('failed', run('a', 'failed'), 'b')).toBe(true);
    expect(keepsChat('failed', run('a', 'stopped'), 'b')).toBe(true);
    expect(keepsChat('latest', run('a', 'failed'), 'b')).toBe(false);
    expect(keepsChat('latest', run('b', 'done'), 'b')).toBe(true);
    expect(keepsChat('latest', run('a', 'running'), 'b')).toBe(true);
    expect(keepsChat('failed', run('a', 'needs-you'), 'b')).toBe(true);
  });
});

/** Fake places that record what was put away and what a Your Mac chat was asked to run on. */
function places(changes = false) {
  const p = fakePlaces({ changes });
  const putAway: string[] = [];
  const macAgents: Array<AgentRef | undefined> = [];
  const all: SentinelPlaces = {
    ...p.places,
    macChat: (run) => {
      macAgents.push(run?.agent);
      return p.places.macChat(run);
    },
    putAway: async (channel) => void putAway.push(channel),
  };
  return { places: all, putAway, macAgents };
}

async function runOnce(s: ReturnType<typeof setup>, id: string): Promise<string> {
  const run = s.sentinels.start(id, 'you');
  await until(() => !['queued', 'running'].includes(s.sentinels.runGet(run.id).run.state));
  return run.id;
}

describe('a sentinel keeps the runs’ chats it’s told to', () => {
  const step = { kind: 'claude' as const, name: 'Look', where: 'project' as const, prompt: 'Look' };

  it('every run by default: nothing is put away', async () => {
    const p = places();
    const s = setup({ reply: () => 'ok', places: p.places });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step] });
    for (let i = 0; i < 3; i++) await runOnce(s, made.id);
    expect(p.putAway).toEqual([]);
  });

  it('failed runs only: a run that went fine puts its chat away, a failed one keeps it', async () => {
    const p = places();
    let n = 0;
    const s = setup({
      places: p.places,
      reply: (a: Asked) => {
        if (++n !== 2) return 'ok';
        queueMicrotask(() => a.fail('It broke'));
        return undefined;
      },
    });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step], keepChats: 'failed' });
    expect(made.keepChats).toBe('failed');
    const first = await runOnce(s, made.id);
    const second = await runOnce(s, made.id);
    await until(() => p.putAway.length === 1);
    expect(p.putAway).toEqual([s.sentinels.runGet(first).run.channel]);
    expect(s.sentinels.runGet(first).run.putAway).toBe(true);
    expect(s.sentinels.runGet(second).run.state).toBe('failed');
    expect(s.sentinels.runGet(second).run.putAway).toBeUndefined();
  });

  it('the latest only: each run puts the one before’s away', async () => {
    const p = places();
    const s = setup({ reply: () => 'ok', places: p.places });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step], keepChats: 'latest' });
    const ids = [await runOnce(s, made.id), await runOnce(s, made.id), await runOnce(s, made.id)];
    await until(() => p.putAway.length === 2);
    expect(ids.map((id) => Boolean(s.sentinels.runGet(id).run.putAway))).toEqual([true, true, false]);
  });

  it('keeping fewer puts the older ones away at once, not at the next run', async () => {
    const p = places();
    const s = setup({ reply: () => 'ok', places: p.places });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step] });
    await runOnce(s, made.id);
    await runOnce(s, made.id);
    expect(p.putAway).toEqual([]);
    s.sentinels.update(made.id, { keepChats: 'failed' });
    await until(() => p.putAway.length === 2);
  });

  it('never puts a worktree away: its work is yours', async () => {
    const p = places(true);
    const s = setup({ reply: () => 'ok', places: p.places, changes: true });
    const made = s.sentinels.create({ name: 'Fixer', projectId: 'api', access: 'work', steps: [{ ...step, where: 'worktree' }], keepChats: 'failed' });
    const id = await runOnce(s, made.id);
    expect(s.sentinels.runGet(id).run.worktreeId).toBeDefined();
    expect(p.putAway).toEqual([]);
  });

  it('a Your Mac step asks for a run’s own chat, on the agent the step chose (Codex too)', async () => {
    const p = places();
    const s = setup({ reply: () => 'ok', places: p.places });
    const made = s.sentinels.create({ name: 'Disk check', steps: [{ kind: 'claude', name: 'Look', where: 'mac', prompt: 'How full is the disk?', runtime: 'codex', model: 'gpt-5.5' }] });
    await runOnce(s, made.id);
    expect(p.macAgents).toEqual([CODEX]);
  });
});

describe('your agent sets it up too', () => {
  it('sentinel_create and sentinel_update take keepChats and a step’s agent', () => {
    const draft = ToolDraftSchema.parse({ name: 'Hourly', trigger: { kind: 'manual' }, steps: [{ kind: 'claude', name: 'Look', prompt: 'Look', where: 'mac', runtime: 'codex', model: 'gpt-5.5' }], keepChats: 'failed' });
    const made = fromToolDraft(draft);
    expect(made.keepChats).toBe('failed');
    expect(made.steps?.[0]).toMatchObject({ runtime: 'codex', model: 'gpt-5.5' });
    expect(ToolPatchSchema.parse({ keepChats: 'latest' }).keepChats).toBe('latest');
    expect(() => ToolPatchSchema.parse({ keepChats: 'some' })).toThrow();
  });
});

/** BLG-571: deleting a chat that ran on Codex drops Codex's thread, as Claude's transcript is dropped. */
describe('a deleted chat takes its agent’s record with it', () => {
  function rollout(home: string, thread: string): string {
    const dir = path.join(home, 'sessions', '2026', '11', '01');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-11-01T10-00-00-${thread}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: '/w' } })}\n`);
    return file;
  }

  function codexStore(): Store {
    const s = store(30);
    s.dispatch({ type: 'prefs', prefs: { defaultAgent: { runtime: 'codex', label: 'Codex' } } });
    return s;
  }

  it('Your Mac: Codex’s thread goes, another thread stays', async () => {
    const codex = tmp();
    const mine = rollout(codex, 'thread-mine');
    const other = rollout(codex, 'thread-other');
    const m = new MacAssistant({ store: codexStore(), dir: tmp(), selfId: () => 'me', system: pretendSystem(), claudeDir: tmp(), codexDir: codex });
    const id = m.newChat();
    m.place(`mac:assistant:${id}`).onSession?.('thread-mine');
    await m.deleteChat(id);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('the Sentinel chat: runs on your default agent, remembers it, and drops Codex’s thread', async () => {
    const codex = tmp();
    const file = rollout(codex, 'thread-s');
    const s = codexStore();
    const chats = new SentinelChats({ store: s, dir: tmp(), selfId: () => 'me', claudeDir: tmp(), codexDir: codex });
    const id = chats.newChat();
    const place = chats.place(sentinelChatChannel(id), 'me')!;
    expect(place.agent?.runtime).toBe('codex');
    place.onSession?.('thread-s');
    // Back on Claude: Codex's thread can't be resumed there, so it starts afresh.
    s.dispatch({ type: 'prefs', prefs: { defaultAgent: { runtime: 'claude', label: 'Claude' } } });
    expect(chats.place(sentinelChatChannel(id), 'me')!.resume).toBeUndefined();
    await chats.deleteChat(id);
    expect(existsSync(file)).toBe(false);
  });
});

/** BLG-570: the sentinels that are on, under the sidebar's Sentinel row, each with its runs' kept chats. */
describe('the sidebar’s sentinels', () => {
  const item = (id: string, name: string, paused = false) => ({ id, name, paused }) as unknown as Sentinel;
  const run = (id: string, sentinelId: string, startedAt: number, state: RunSummary['state'], extra: Partial<RunSummary> = {}) =>
    ({ id, sentinelId, startedAt, state, headline: `${id} done`, steps: [{ id: 's1', state: 'done', channel: `ws:${id}` }], tasks: [], by: 'schedule', trigger: { kind: 'schedule', summary: '' }, ...extra }) as unknown as RunSummary;

  it('lists the ones that are on (and a paused one still running or waiting), the one that ran last first', () => {
    const items = [item('a', 'Alpha'), item('b', 'Beta'), item('p', 'Paused', true), item('w', 'Waits', true), item('n', 'Never ran')];
    const runs = [run('r1', 'a', 10, 'done'), run('r2', 'b', 20, 'failed'), run('r3', 'p', 30, 'done'), run('r4', 'w', 5, 'needs-you')];
    const side = sidebarSentinels({ items, runs });
    expect(side.map((x) => x.sentinel.id)).toEqual(['b', 'a', 'w', 'n']);
    expect(side[0]).toMatchObject({ failed: true, live: false, needs: false });
    expect(side.find((x) => x.sentinel.id === 'w')?.needs).toBe(true);
  });

  it('folded, only those that need a look: running, waiting for you, or the last run failed', () => {
    const items = [item('a', 'Quiet'), item('b', 'Broke'), item('c', 'Going'), item('w', 'Waits', true)];
    const runs = [run('r1', 'a', 10, 'done'), run('r2', 'b', 20, 'failed'), run('r3', 'c', 30, 'running'), run('r4', 'w', 5, 'needs-you')];
    expect(sidebarSentinels({ items, runs }).filter(needsALook).map((x) => x.sentinel.id)).toEqual(['c', 'b', 'w']);
  });

  it('one that stopped on its own stays under the row, folded, so the problem mark has its cause', () => {
    const stuck = { ...item('f', 'Flaky', true), pausedWhy: 'Paused after 3 failures in a row' } as Sentinel;
    const changed = { ...item('c', 'Changed', true), pausedWhy: CLAUDE_CHANGED } as Sentinel;
    const items = [item('a', 'Quiet'), stuck, changed, item('h', 'By hand', true)];
    const runs = [run('r1', 'a', 30, 'done'), run('r2', 'f', 20, 'failed'), run('r3', 'c', 10, 'done'), run('r4', 'h', 5, 'done')];
    const side = sidebarSentinels({ items, runs });
    expect(side.map((x) => x.sentinel.id)).toEqual(['a', 'f']);
    expect(side.filter(needsALook).map((x) => x.sentinel.id)).toEqual(['f']);
    expect(side[1]!.broken).toBe('Paused after 3 failures in a row');
  });

  it('its runs (BLG-576): every one, newest first, scripts-only too, each with its chat while it’s kept', () => {
    const runs = [run('r1', 'a', 10, 'done', { putAway: true }), run('r2', 'a', 20, 'failed'), run('r3', 'a', 30, 'done', { channel: 'mac:assistant:abc12', steps: [] }), run('r4', 'a', 40, 'skipped', { steps: [] })];
    const [a] = sidebarSentinels({ items: [item('a', 'Alpha')], runs });
    expect(a!.runs.map((r) => [r.runId, r.chat])).toEqual([
      ['r4', undefined],
      ['r3', 'mac:assistant:abc12'],
      ['r2', 'ws:r2'],
      ['r1', undefined],
    ]);
  });
});

/** BLG-577: delete a run's chat, or the whole run, as you ask: on its page or through your agent. */
describe('deleting what a run left', () => {
  const step = { kind: 'claude' as const, name: 'Look', where: 'project' as const, prompt: 'Look' };

  function withDelete() {
    const p = places();
    const deleted: string[] = [];
    const all: SentinelPlaces = { ...p.places, deleteChat: async (channel) => void deleted.push(channel) };
    return { places: all, deleted };
  }

  it('Delete Chat: its conversation goes for good, the run and its report stay', async () => {
    const p = withDelete();
    const s = setup({ reply: () => 'All good', places: p.places });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step] });
    const id = await runOnce(s, made.id);
    const channel = s.sentinels.runGet(id).run.channel!;
    await s.sentinels.runDelete(id, 'chat');
    expect(p.deleted).toEqual([channel]);
    const after = s.sentinels.runGet(id);
    expect(after.run).toMatchObject({ chatDeleted: true, putAway: true });
    expect(after.report).toContain('All good');
    // Twice: nothing more to delete.
    await s.sentinels.runDelete(id, 'chat');
    expect(p.deleted).toHaveLength(1);
  });

  it('Delete Run: its chat, folder and line in the history go', async () => {
    const p = withDelete();
    const s = setup({ reply: () => 'ok', places: p.places });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step] });
    const id = await runOnce(s, made.id);
    await s.sentinels.runDelete(id, 'run');
    expect(p.deleted).toHaveLength(1);
    expect(() => s.sentinels.runGet(id)).toThrow(/gone/);
    expect(s.store.getState().sentinel.runs.some((r) => r.id === id)).toBe(false);
  });

  it('never a run still going', async () => {
    const p = withDelete();
    const s = setup({ reply: () => undefined, places: p.places });
    const made = s.sentinels.create({ name: 'Slow', projectId: 'api', steps: [step] });
    const run = s.sentinels.start(made.id, 'you');
    await until(() => s.asked.length === 1);
    await expect(s.sentinels.runDelete(run.id, 'run')).rejects.toThrow(/still going: stop it first/);
  });

  it('your agent: lists the runs, then deletes those that went fine, through your approval', async () => {
    const p = withDelete();
    let n = 0;
    const s = setup({
      places: p.places,
      reply: (a: Asked) => {
        if (++n !== 2) return 'ok';
        queueMicrotask(() => a.fail('It broke'));
        return undefined;
      },
    });
    const made = s.sentinels.create({ name: 'Hourly', projectId: 'api', steps: [step] });
    for (let i = 0; i < 3; i++) await runOnce(s, made.id);
    const tools = s.sentinels.forRun('ws:elsewhere', 'p-me')!.tools;
    expect(tools.runs('Hourly')).toMatch(/3 runs, newest first/);
    expect(await tools.deleteRuns('Hourly', { state: 'done' }, 'run')).toMatch(/Deleted 2 runs/);
    expect(s.store.getState().sentinel.runs.filter((r) => r.sentinelId === made.id).map((r) => r.state)).toEqual(['failed']);
    await expect(tools.deleteRuns('Hourly', {}, 'chat')).rejects.toThrow(/Say which runs/);
    expect(ALWAYS_ASK_YOU.has('mcp__beluga_sentinel__sentinel_delete_runs')).toBe(true);
  });
});
