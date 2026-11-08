import { describe, expect, it } from 'vitest';
import { AutoContinue, limitStops, resumeOf, sentinelRunChat } from '../src/core/auto-continue.js';
import { Store, initialState, prefsFrom } from '../src/core/store.js';
import { AUTO_CONTINUE_LATE_MS, AUTO_CONTINUE_OFF_MAX, LIMIT_MARGIN_MS, LIMIT_UNKNOWN_MS, autoContinueFor, autoContinues, chatsOff, limitResumeAt, sessionSkip } from '../src/shared/auto-continue.js';
import { Settings } from '../src/shared/settings-schema.js';
import { CONTINUE_PROMPT, encodeFailure } from '../src/shared/run-failure.js';
import { convTurns } from '../src/companion/views.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

/** BLG-757: after your usage limit resets, the agent that stopped on it is told to continue on its own. */

const MIN = 60_000;
const T0 = new Date(2026, 10, 7, 12, 0).getTime();
const RESET = T0 + 3 * 60 * MIN;
const ON = { autoContinue: true, autoContinueOff: [] as string[], autoContinueSkip: 0 };

const ws = (id: string, extra: Partial<Workspace> = {}): Workspace => ({ id, projectId: 'p', name: id, path: `/tmp/${id}`, kind: 'worktree', projectRoot: '/tmp/p', branch: `beluga/${id}`, createdAt: 0, external: false, ...extra }) as unknown as Workspace;

function world() {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'identity', selfId: 'p-me', isHost: true });
  const project: Project = { id: 'p', name: 'api', root: '/tmp/p', base: 'main', workspaces: [ws('w1'), ws('w2'), ws('old', { archived: true } as Partial<Workspace>)] } as unknown as Project;
  store.dispatch({ type: 'projects', projects: [project] });
  let now = T0;
  const asked: Array<{ prompt: string; channel: string }> = [];
  let refuse = false;
  const auto = new AutoContinue({
    store,
    ask: (prompt, channel) => {
      if (refuse) return undefined;
      asked.push({ prompt, channel });
      return `ask${asked.length}`;
    },
    now: () => now,
  });
  const run = (requestId: string, channel: string, kind: 'started' | 'error' | 'done', text = '', owner = 'p-me'): void =>
    store.dispatch({ type: 'agent_event', owner, requestId, requester: owner, event: kind, text, ts: now, channel });
  const limit = (requestId: string, channel: string, resetsAt: number | null = RESET, owner = 'p-me'): void => {
    run(requestId, channel, 'started', '', owner);
    run(requestId, channel, 'error', encodeFailure({ kind: 'usage_limit', detail: 'limit', ...(resetsAt ? { resetsAt } : {}) }, now), owner);
  };
  const at = (t: number): void => {
    now = t;
    auto.tick();
  };
  return { store, asked, run, limit, at, auto, now: () => now, refuse: (on: boolean) => void (refuse = on) };
}

describe('the rules', () => {
  it('goes in agent conversations, never in chats between people', () => {
    expect(autoContinues('ws:w1')).toBe(true);
    expect(autoContinues('mac:assistant')).toBe(true);
    expect(autoContinues('sentinel-chat:main')).toBe(true);
    for (const people of ['room', 'dm:abc', 'group:xyz']) {
      expect(autoContinues(people)).toBe(false);
      expect(autoContinueFor(ON, people, RESET)).toEqual({ kind: 'off', why: 'people', at: RESET });
    }
  });

  it('a minute after the reset, or 30 minutes after it stopped when the reset is unknown', () => {
    expect(limitResumeAt({ resetsAt: RESET }, T0)).toBe(RESET + LIMIT_MARGIN_MS);
    expect(limitResumeAt({}, T0)).toBe(T0 + LIMIT_UNKNOWN_MS + LIMIT_MARGIN_MS);
  });

  it('is on by default, off everywhere, in a chat, this session, or once too late', () => {
    expect(Settings.parse({})).toMatchObject(ON);
    expect(prefsFrom({})).toMatchObject(ON);
    const at = RESET + LIMIT_MARGIN_MS;
    expect(autoContinueFor(ON, 'ws:w1', at)).toEqual({ kind: 'scheduled', at });
    expect(autoContinueFor({ ...ON, autoContinue: false }, 'ws:w1', at)).toMatchObject({ kind: 'off', why: 'everywhere' });
    expect(autoContinueFor({ ...ON, autoContinueOff: ['ws:w1'] }, 'ws:w1', at)).toMatchObject({ kind: 'off', why: 'chat' });
    expect(autoContinueFor({ ...ON, autoContinueOff: ['ws:w1'] }, 'ws:w2', at)).toMatchObject({ kind: 'scheduled' });
    // This session: the resume due at this reset (and chats that stopped a little later), not the next limit's.
    const skip = sessionSkip(at);
    expect(autoContinueFor({ ...ON, autoContinueSkip: skip }, 'ws:w2', at + 5 * MIN)).toMatchObject({ kind: 'off', why: 'session' });
    expect(autoContinueFor({ ...ON, autoContinueSkip: skip }, 'ws:w2', at + 5 * 60 * MIN)).toMatchObject({ kind: 'scheduled' });
    // Too late (Beluga wasn't running): left to you; plans (no `now`) don't mind.
    expect(autoContinueFor(ON, 'ws:w1', at, at + AUTO_CONTINUE_LATE_MS + 1)).toMatchObject({ kind: 'off', why: 'late' });
    expect(autoContinueFor(ON, 'ws:w1', at, at + MIN)).toMatchObject({ kind: 'scheduled' });
  });

  it('keeps the chats it is off in, newest last and capped', () => {
    expect(chatsOff(['ws:a', 'ws:b'], 'ws:a', true)).toEqual(['ws:b', 'ws:a']);
    expect(chatsOff(['ws:a', 'ws:b'], 'ws:a', false)).toEqual(['ws:b']);
    const full = Array.from({ length: AUTO_CONTINUE_OFF_MAX }, (_, i) => `ws:${i}`);
    const next = chatsOff(full, 'ws:new', true);
    expect(next).toHaveLength(AUTO_CONTINUE_OFF_MAX);
    expect(next[0]).toBe('ws:1');
    expect(next.at(-1)).toBe('ws:new');
  });
});

describe('which conversations stopped on the limit', () => {
  it('only your newest run, when it stopped on the limit and nothing runs behind it', () => {
    const w = world();
    w.limit('r1', 'ws:w1');
    w.limit('r2', 'ws:w2');
    w.run('r3', 'ws:w2', 'started');
    w.limit('r4', 'room');
    w.limit('r5', 'mac:assistant', RESET, 'p-friend');
    const stops = limitStops(w.store.getState().log, 'p-me');
    expect(stops.map((s) => s.channel)).toEqual(['ws:w1']);
    expect(stops[0]).toMatchObject({ requestId: 'r1', at: RESET + LIMIT_MARGIN_MS });
    // A newer run that ended fine: nothing to continue.
    w.run('r6', 'ws:w1', 'started');
    w.run('r6', 'ws:w1', 'done', 'All done.');
    expect(limitStops(w.store.getState().log, 'p-me')).toEqual([]);
  });
});

describe('sending it on', () => {
  it('waits for the reset, then tells the agent to continue once, with a line in the chat', () => {
    const w = world();
    w.limit('r1', 'ws:w1');
    w.at(RESET);
    expect(w.asked).toEqual([]);
    w.at(RESET + LIMIT_MARGIN_MS);
    expect(w.asked).toEqual([{ prompt: CONTINUE_PROMPT, channel: 'ws:w1' }]);
    expect(w.store.getState().log.some((l) => l.type === 'system' && l.channel === 'ws:w1' && /usage limit reset/.test(l.text))).toBe(true);
    w.at(RESET + 2 * MIN);
    expect(w.asked).toHaveLength(1);
    w.auto.stop();
  });

  it('not when turned off everywhere, in that chat, or this session; turned back on, it goes', async () => {
    const w = world();
    w.limit('r1', 'ws:w1');
    w.limit('r2', 'ws:w2');
    w.store.dispatch({ type: 'prefs', prefs: { autoContinueOff: ['ws:w1'], autoContinueSkip: 0 } });
    w.at(RESET + LIMIT_MARGIN_MS);
    expect(w.asked.map((a) => a.channel)).toEqual(['ws:w2']);
    // Back on in that chat: it goes in a moment (it's due).
    w.store.dispatch({ type: 'prefs', prefs: { autoContinueOff: [] } });
    await new Promise((r) => setTimeout(r, 5));
    expect(w.asked.map((a) => a.channel)).toEqual(['ws:w2', 'ws:w1']);
    w.auto.stop();
  });

  it('skips this session in every chat, and everywhere when off', () => {
    const w = world();
    w.limit('r1', 'ws:w1');
    w.store.dispatch({ type: 'prefs', prefs: { autoContinueSkip: sessionSkip(RESET + LIMIT_MARGIN_MS) } });
    w.at(RESET + 5 * MIN);
    w.store.dispatch({ type: 'prefs', prefs: { autoContinueSkip: 0, autoContinue: false } });
    w.at(RESET + 6 * MIN);
    expect(w.asked).toEqual([]);
    w.auto.stop();
  });

  it('not into an archived worktree, nor hours late, nor a chat between people', () => {
    const w = world();
    w.limit('r1', 'ws:old');
    w.limit('r2', 'room');
    w.limit('r3', 'ws:w1');
    w.at(RESET + LIMIT_MARGIN_MS + AUTO_CONTINUE_LATE_MS + MIN);
    expect(w.asked).toEqual([]);
    w.auto.stop();
  });

  it('never loops: stopping again on a guessed or already-past reset waits for you', () => {
    const w = world();
    w.limit('r1', 'ws:w1', null);
    w.at(T0 + LIMIT_UNKNOWN_MS + LIMIT_MARGIN_MS);
    expect(w.asked).toHaveLength(1);
    // The continue stopped on the limit again, with no reset said: not sent again, however long.
    w.limit('r2', 'ws:w1', null);
    w.at(w.now() + 2 * LIMIT_UNKNOWN_MS);
    expect(w.asked).toHaveLength(1);
    // A reset the limit names, later than the last send: sent on then.
    const next = w.now() + 60 * MIN;
    w.limit('r3', 'ws:w1', next);
    w.at(next + LIMIT_MARGIN_MS);
    expect(w.asked).toHaveLength(2);
    // One that names a reset already past: not again.
    w.limit('r4', 'ws:w1', w.now() - MIN);
    w.at(w.now() + MIN);
    expect(w.asked).toHaveLength(2);
    w.auto.stop();
  });

  it('says nothing in the chat when the agent couldn’t be asked there', () => {
    const w = world();
    w.limit('r1', 'ws:w1');
    w.refuse(true);
    w.at(RESET + LIMIT_MARGIN_MS);
    expect(w.store.getState().log.some((l) => l.type === 'system' && /usage limit reset/.test(l.text))).toBe(false);
    w.auto.stop();
  });

  it('not into a sentinel run’s chat: the sentinel runs again itself', () => {
    const w = world();
    w.limit('r1', 'ws:w1');
    const run = { id: 'run1', sentinelId: 's1', steps: [{ channel: 'ws:w1' }] };
    w.store.dispatch({ type: 'sentinel_init', state: { ...w.store.getState().sentinel, items: [{ id: 's1' }], runs: [run] } } as never);
    expect(sentinelRunChat(w.store.getState(), 'ws:w1')).toBe(true);
    expect(resumeOf(w.store.getState(), 'ws:w1', T0)).toBeUndefined();
    w.at(RESET + LIMIT_MARGIN_MS);
    expect(w.asked).toEqual([]);
    w.auto.stop();
  });

  it('the phone sees when it continues, until it has', () => {
    const w = world();
    w.limit('r1', 'ws:w1');
    const card = w.store.getState().log.find((l) => l.type === 'agent' && l.requestId === 'r1')!;
    expect(resumeOf(w.store.getState(), 'ws:w1', T0)).toEqual({ id: card.id, at: RESET + LIMIT_MARGIN_MS });
    expect(resumeOf(w.store.getState(), 'ws:w1', RESET + 2 * MIN)).toBeUndefined();
    w.store.dispatch({ type: 'prefs', prefs: { autoContinueOff: ['ws:w1'] } });
    expect(resumeOf(w.store.getState(), 'ws:w1', T0)).toBeUndefined();
    w.auto.stop();
  });

  it('says it on the phone turn of the stopped run', () => {
    const w = world();
    w.limit('r1', 'ws:w1', Date.now() + 60 * MIN);
    const refs = { output: () => undefined, image: () => undefined } as never;
    const { turns } = convTurns(w.store.getState(), { refs } as never, 'ws:w1');
    expect(turns.at(-1)?.resumesAt).toBeGreaterThan(Date.now());
    w.auto.stop();
  });
});
