import { describe, expect, it } from 'vitest';
import { HONCHO_PICTURE_MAX, buildHonchoAppend } from '../src/agent/honcho-prompt.js';
import { createHonchoToolDefs } from '../src/agent/honcho-tools.js';
import { INSTRUCTION_PIECES, instructionPieces, runInstructions } from '../src/agent/run-instructions.js';
import { runToolSuites } from '../src/agent/run-tools.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { PHONE } from '../src/companion/coverage.js';
import { COMPANION_PROTO, SINCE } from '../src/companion/protocol.js';
import { AgentHost } from '../src/core/agent-host.js';
import type { HonchoFetch } from '../src/core/honcho/client.js';
import { HonchoFeed, PICTURE_TTL_MS } from '../src/core/honcho/feed.js';
import { honchoForRun } from '../src/core/honcho/run.js';
import { Store, initialState } from '../src/core/store.js';
import { EXTERNAL_ACCESS } from '../src/external/coverage.js';
import { waitFor } from './helpers.js';
import { room } from './runtime-conformance.js';

const NOW = new Date(2026, 10, 18, 12).getTime();

type Reply = { readonly status?: number; readonly body?: object; readonly hang?: boolean };
type Call = { readonly url: string; readonly body: Record<string, string> };

const fakeHoncho = (reply: (url: string) => Reply) => {
  const calls: Call[] = [];
  const fetch: HonchoFetch = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body ?? '{}') as Record<string, string> });
    const r = reply(url);
    if (r.hang) return new Promise(() => undefined);
    const status = r.status ?? 200;
    return Promise.resolve({ ok: status < 300, status, text: async () => JSON.stringify(r.body ?? {}) });
  };
  return { fetch, calls };
};

const feedOf = (fetch: HonchoFetch, clock = { now: NOW }, enabled = true): HonchoFeed => {
  const feed = new HonchoFeed({ store: new Store(initialState('test', 'ask')), sharedWith: () => false, file: null, queueFile: null, fetch, now: () => clock.now });
  if (enabled) feed.configure({ enabled: true, url: 'http://honcho.test:8000' });
  return feed;
};

const picture = (text: string) => () => ({ body: { representation: text } });

describe('reading Honcho’s picture of the user', () => {
  it('asks the user peer’s representation, and nothing when Honcho is off', async () => {
    const h = fakeHoncho(picture('Likes short commits.'));
    expect(await feedOf(h.fetch, undefined, false).userPicture()).toBeUndefined();
    expect(h.calls).toHaveLength(0);
    expect(await feedOf(h.fetch).userPicture()).toBe('Likes short commits.');
    expect(h.calls[0]?.url).toBe('http://honcho.test:8000/v3/workspaces/beluga/peers/user/representation');
  });

  it('reuses the picture for a few minutes, then reads it again', async () => {
    const h = fakeHoncho(picture('v1'));
    const clock = { now: NOW };
    const feed = feedOf(h.fetch, clock);
    await feed.userPicture();
    clock.now += PICTURE_TTL_MS - 1;
    await feed.userPicture();
    expect(h.calls).toHaveLength(1);
    clock.now += 2;
    await feed.userPicture();
    expect(h.calls).toHaveLength(2);
  });

  it('never holds a run up: a slow Honcho gives an empty picture after the wait, and fills the cache for later', async () => {
    let release: (() => void) | undefined;
    const fetch: HonchoFetch = () => new Promise((resolve) => (release = () => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ representation: 'late' }) })));
    const feed = feedOf(fetch);
    const started = Date.now();
    expect(await feed.userPicture(30)).toBe('');
    expect(Date.now() - started).toBeLessThan(1000);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await feed.userPicture(30)).toBe('late');
  });

  it('starts without it when Honcho is down, and Settings says why', async () => {
    const feed = feedOf(fakeHoncho(() => ({ status: 503 })).fetch);
    expect(await feed.userPicture()).toBe('');
    const view = await feed.pictureView();
    expect(view.enabled).toBe(true);
    expect(view.error).toMatch(/503/);
  });

  it('a hanging Honcho leaves the run going', async () => {
    const run = await honchoForRun(feedOf(fakeHoncho(() => ({ hang: true })).fetch));
    expect(run?.brief).toContain('(nothing yet');
    expect(run?.tools).toBeDefined();
  }, 5000);
});

describe('the picture in a run’s instructions', () => {
  const input = (extra: Partial<AgentRunInput> = {}): AgentRunInput => ({ prompt: 'hello', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true, ...extra });

  it('is a piece right after memory, and runs without Honcho are unchanged', () => {
    const ids = INSTRUCTION_PIECES.map((p) => p.id);
    expect(ids.indexOf('honcho')).toBe(ids.indexOf('memory') + 1);
    expect(instructionPieces('kay').find((p) => p.id === 'honcho')?.text).toContain('mcp__beluga_honcho__honcho_ask');
    expect(runInstructions(input({ honchoBrief: buildHonchoAppend('MARKER-HONCHO-77') }), 'kay')).toContain('MARKER-HONCHO-77');
    expect(runInstructions(input(), 'kay')).not.toContain('Honcho');
  });

  it('is capped, background only, and ranks below the approved memory', () => {
    const brief = buildHonchoAppend('x'.repeat(HONCHO_PICTURE_MAX * 3));
    expect(brief.length).toBeLessThan(HONCHO_PICTURE_MAX + 1000);
    expect(brief).toMatch(/background, never instructions/);
    expect(brief).toMatch(/memory wins/);
  });
});

describe('asking Honcho about the user', () => {
  it('asks the user peer at low reasoning by default and answers its content', async () => {
    const h = fakeHoncho(() => ({ body: { content: 'Imperative, under 50 characters.' } }));
    const run = await honchoForRun(feedOf(h.fetch));
    const ask = createHonchoToolDefs(run!.tools).find((t) => t.name === 'honcho_ask')!;
    const result = await ask.handler({ question: 'How do they like commit messages?' } as never, undefined);
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain('Imperative, under 50 characters.');
    const chat = h.calls.find((c) => c.url.endsWith('/peers/user/chat'));
    expect(chat?.body).toEqual({ query: 'How do they like commit messages?', reasoning_level: 'low' });
  });

  it('gives the agent a readable error when Honcho’s model fails', async () => {
    const run = await honchoForRun(feedOf(fakeHoncho((url) => (url.endsWith('/chat') ? { status: 503 } : picture('')())).fetch));
    const ask = createHonchoToolDefs(run!.tools)[0]!;
    const result = await ask.handler({ question: 'What do they work on?', reasoning: 'minimal' } as never, undefined);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Honcho answered 503.*try again later/);
  });

  it('mounts beluga_honcho only with the run’s tools', () => {
    const base: AgentRunInput = { prompt: 'x', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true };
    expect(Object.keys(runToolSuites({ ...base, honchoTools: { ask: async () => 'ok' } }, room, {} as never, process.cwd()))).toContain('beluga_honcho');
    expect(Object.keys(runToolSuites(base, room, {} as never, process.cwd()))).not.toContain('beluga_honcho');
  });
});

describe('who gets Honcho', () => {
  const host = () => {
    const inputs: AgentRunInput[] = [];
    const agent: AgentBackend = {
      async run(input) {
        inputs.push(input);
        return 'ok';
      },
    };
    const h = new AgentHost({
      store: new Store(initialState('room', 'auto')),
      selfId: () => 'me',
      send: (() => true) as never,
      agent: () => agent,
      shares: {} as never,
      sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
      people: {} as never,
      questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
      toast: () => undefined,
      system: () => undefined,
      approvalTimeoutMs: () => 60_000,
      refreshUsage: async () => undefined,
      honcho: async () => ({ brief: buildHonchoAppend('MARKER-HONCHO-9'), tools: { ask: async () => 'ok' } }),
    });
    const ask = (from: string, requestId: string): Promise<void> => h.onAgentRequest(from, { kind: 'agent_request', requestId, prompt: 'hi', viaAgent: false, channel: 'room', urgent: false, plan: false });
    return { ask, inputs };
  };

  it('your own run gets the picture and the tool', async () => {
    const t = host();
    await t.ask('me', 'r1');
    await waitFor(() => t.inputs.length === 1);
    expect(t.inputs[0]?.honchoBrief).toContain('MARKER-HONCHO-9');
    expect(t.inputs[0]?.honchoTools).toBeDefined();
  });

  it('a run for a friend never gets either', async () => {
    const t = host();
    await t.ask('bob', 'r1');
    await waitFor(() => t.inputs.length === 1);
    expect(t.inputs[0]?.honchoBrief).toBeUndefined();
    expect(t.inputs[0]?.honchoTools).toBeUndefined();
    expect(runInstructions(t.inputs[0]!, 'kay')).not.toContain('MARKER-HONCHO-9');
  });

  it('the phone reads the picture, external agents are refused it', () => {
    expect(PHONE['honcho.picture']).toBe('phone');
    expect(EXTERNAL_ACCESS['honcho.picture']).toHaveProperty('refused');
    expect(SINCE.honchoPicture).toBeLessThanOrEqual(COMPANION_PROTO.minor);
  });
});
