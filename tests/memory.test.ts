import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryToolDefs } from '../src/agent/memory-tools.js';
import { INSTRUCTION_PIECES, instructionPieces, runInstructions } from '../src/agent/run-instructions.js';
import { runToolSuites } from '../src/agent/run-tools.js';
import { createCodexBackend } from '../src/agent/runtime/codex/runner.js';
import { createOpenCodeBackend } from '../src/agent/runtime/opencode/runner.js';
import { ScriptedOpenCode } from '../src/agent/runtime/opencode/scripted.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import { memoryForRun } from '../src/core/memory/run.js';
import { MemoryError, MemoryStore, secretInMemory } from '../src/core/memory/store.js';
import { Store, initialState } from '../src/core/store.js';
import { PROJECT_MEMORY_MAX, USER_MEMORY_MAX } from '../src/shared/memory.js';
import { FakeCodex } from './fake-codex.js';
import { waitFor } from './helpers.js';
import { room } from './runtime-conformance.js';

const tempHome = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-memory-'));
const USER = { kind: 'user' } as const;
const PROJECT = { kind: 'project', root: '/work/landing' } as const;

describe('the memory store', () => {
  it('adds, replaces and removes entries, about you and per project, in 0600 files under memory/', () => {
    const home = tempHome();
    const store = new MemoryStore(home);
    const added = store.add(USER, '  Prefers   short answers. ', 'agent');
    expect(added.entries).toMatchObject([{ text: 'Prefers short answers.', by: 'agent' }]);
    expect(added).toMatchObject({ used: 22, cap: USER_MEMORY_MAX });
    store.add(PROJECT, 'Deploys go through the NAS.', 'you');
    expect(store.read(PROJECT).cap).toBe(PROJECT_MEMORY_MAX);
    expect(store.read(USER).entries).toHaveLength(1);

    const id = added.entries[0]!.id;
    expect(store.replace(USER, id, 'Prefers short, plain answers.', 'you').entries[0]).toMatchObject({ id, text: 'Prefers short, plain answers.', by: 'you' });
    expect(store.replace(USER, 'plain answers', 'Likes plain answers.', 'agent').entries[0]!.text).toBe('Likes plain answers.');
    expect(store.remove(USER, id).entries).toEqual([]);

    const user = path.join(home, 'memory', 'user.json');
    expect(statSync(user).mode & 0o777).toBe(0o600);
    const [projectFile] = readdirSync(path.join(home, 'memory', 'projects'));
    expect(JSON.parse(readFileSync(path.join(home, 'memory', 'projects', projectFile!), 'utf8')).root).toBe('/work/landing');
    expect(store.projectRoots()).toEqual(['/work/landing']);
  });

  it('enforces the cap, and tells the agent to merge or drop entries', () => {
    const store = new MemoryStore(tempHome());
    store.add(USER, 'a'.repeat(USER_MEMORY_MAX - 10), 'agent');
    expect(() => store.add(USER, 'one more fact here', 'agent')).toThrow(/full.*memory_replace.*memory_remove/);
    expect(store.read(USER).entries).toHaveLength(1);
    store.add(PROJECT, 'b'.repeat(PROJECT_MEMORY_MAX), 'agent');
    expect(() => store.add(PROJECT, 'x', 'agent')).toThrow(MemoryError);
  });

  it('lets a write that makes the memory smaller through, even over the cap', () => {
    const home = tempHome();
    const store = new MemoryStore(home);
    const id = store.add(USER, 'short', 'you').entries[0]!.id;
    writeFileSync(path.join(home, 'memory', 'user.json'), JSON.stringify({ entries: [{ id, text: 'z'.repeat(USER_MEMORY_MAX + 50), at: 0, by: 'you' }] }));
    expect(store.replace(USER, id, 'z'.repeat(USER_MEMORY_MAX + 10), 'you').used).toBe(USER_MEMORY_MAX + 10);
    expect(store.remove(USER, id).used).toBe(0);
  });

  it('merges entries in one write, and refuses a merge that would leave a secret (BLG-120)', () => {
    const store = new MemoryStore(tempHome());
    const [a, b, c] = ['Uses Helium on arch.', 'Uses Chromium on m1arch.', 'Uses zsh.'].map((t) => store.add(USER, t, 'agent').entries.at(-1)!);
    const merged = store.merge(USER, a!.id, [b!.id, a!.id], 'Uses Helium on arch, Chromium on m1arch.', 'you');
    expect(merged.entries.map((e) => [e.id, e.text, e.by])).toEqual([
      [a!.id, 'Uses Helium on arch, Chromium on m1arch.', 'you'],
      [c!.id, 'Uses zsh.', 'agent'],
    ]);
    expect(() => store.merge(USER, a!.id, [c!.id], 'NAS password: hunter22', 'you')).toThrow(/Secrets/);
    expect(() => store.merge(USER, a!.id, ['gone'], 'x', 'you')).toThrow(/No entry/);
    expect(store.read(USER).entries).toHaveLength(2);
  });

  it('moves an entry between memories, and puts the target back when the source cannot be written (BLG-121)', () => {
    const home = tempHome();
    const store = new MemoryStore(home);
    const id = store.add(USER, 'Landing deploys through the NAS.', 'agent').entries[0]!.id;
    store.add(PROJECT, 'Uses pnpm.', 'you');
    expect(store.move(USER, PROJECT, id, 'Deploys through the NAS.', 'you').entries.map((e) => e.text)).toEqual(['Uses pnpm.', 'Deploys through the NAS.']);
    expect(store.read(USER).entries).toEqual([]);

    const back = store.read(PROJECT).entries[1]!.id;
    if (process.getuid?.() === 0) return;
    const projects = path.join(home, 'memory', 'projects');
    chmodSync(projects, 0o500);
    try {
      expect(() => store.move(PROJECT, USER, back, 'Deploys through the NAS.', 'you')).toThrow();
    } finally {
      chmodSync(projects, 0o700);
    }
    expect(store.read(PROJECT).entries.map((e) => e.text)).toEqual(['Uses pnpm.', 'Deploys through the NAS.']);
    expect(store.read(USER).entries).toEqual([]);
  });

  it('refuses what looks like a secret, empty text and duplicates', () => {
    const store = new MemoryStore(tempHome());
    expect(() => store.add(USER, 'The key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'agent')).toThrow(/Secrets never go into memory/);
    expect(() => store.add(USER, 'NAS password: hunter22', 'agent')).toThrow(/Secrets never go into memory/);
    expect(() => store.add(PROJECT, 'DB is postgres://app:s3cretpw@db/app', 'agent')).toThrow(/Secrets/);
    expect(() => store.add(USER, '   ', 'agent')).toThrow(/needs some text/);
    store.add(USER, 'Uses zsh everywhere.', 'agent');
    expect(() => store.add(USER, 'uses zsh everywhere.', 'agent')).toThrow(/already/);
    expect(secretInMemory('The token lives in the keychain.')).toBeUndefined();
  });

  it('asks for an id when a piece of text matches several entries, and says when none does', () => {
    const store = new MemoryStore(tempHome());
    store.add(USER, 'Likes tests first.', 'agent');
    store.add(USER, 'Likes small commits.', 'agent');
    expect(() => store.remove(USER, 'Likes')).toThrow(/matches 2 entries/);
    expect(() => store.remove(USER, 'nothing like it')).toThrow(/No entry/);
  });

  it('keeps an unreadable file aside and starts empty', () => {
    const home = tempHome();
    const store = new MemoryStore(home);
    store.add(USER, 'x fact', 'you');
    writeFileSync(path.join(home, 'memory', 'user.json'), '{nope');
    expect(store.read(USER).entries).toEqual([]);
    expect(readdirSync(path.join(home, 'memory')).some((n) => n.startsWith('user.json.unreadable-'))).toBe(true);
  });
});

describe('a run’s memory', () => {
  const run = (project = true) => memoryForRun(new MemoryStore(tempHome()), project ? { root: '/work/landing', name: 'landing' } : undefined);

  it('puts both memories in the brief, and the tools write as the agent', () => {
    const memory = run();
    memory.tools.add('user', 'Prefers short answers.');
    const said = memory.tools.add('project', 'Run npm ci before tests.');
    expect(said).toMatch(/^Remembered\. Memory of landing \(\d+ of 2200 characters\):\n- \[[0-9a-f]{6}\] Run npm ci before tests\./);
    expect(memory.tools.list()).toContain('Prefers short answers.');
    expect(memory.brief).toContain('<memory scope="user"');
    expect(memory.brief).toContain('project="landing"');
  });

  it('has no project memory outside a project', () => {
    const memory = run(false);
    expect(memory.brief).not.toContain('scope="project"');
    expect(() => memory.tools.add('project', 'x')).toThrow(/not in a project/);
  });

  it('answers an error to the agent instead of throwing, over the cap', async () => {
    const memory = run();
    memory.tools.add('user', 'a'.repeat(USER_MEMORY_MAX));
    const add = createMemoryToolDefs(memory.tools).find((t) => t.name === 'memory_add')!;
    const result = await add.handler({ scope: 'user', text: 'one more' } as never, undefined);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Merge related entries/);
  });
});

describe('memory in the instructions, on every runtime', () => {
  const shared = new MemoryStore(tempHome());
  shared.add({ kind: 'user' }, 'MARKER-MEMORY-4411', 'agent');
  const memory = memoryForRun(shared, { root: '/work/landing', name: 'landing' });
  const withMemory = memoryForRun(new MemoryStore(tempHome()), undefined);

  const input = (extra: Partial<AgentRunInput> = {}): AgentRunInput & { events: Array<[string, string]> } => {
    const events: Array<[string, string]> = [];
    return { prompt: 'hello', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: (k, t) => void events.push([k, t]), onFileTouched: () => undefined, canUseTool: async () => true, events, ...extra };
  };

  it('is a piece of INSTRUCTION_PIECES, listed in Settings with a sample', () => {
    expect(INSTRUCTION_PIECES.map((p) => p.id)).toContain('memory');
    expect(instructionPieces('kay').find((p) => p.id === 'memory')?.text).toContain('mcp__beluga_memory__memory_add');
    expect(runInstructions(input({ memoryBrief: memory.brief }), 'kay')).toContain('MARKER-MEMORY-4411');
    expect(runInstructions(input(), 'kay')).not.toContain('Beluga’s memory');
  });

  it('mounts beluga_memory with the run’s tools, and only then', () => {
    expect(Object.keys(runToolSuites(input({ memoryTools: withMemory.tools }), room, {} as never, process.cwd()))).toContain('beluga_memory');
    expect(Object.keys(runToolSuites(input(), room, {} as never, process.cwd()))).not.toContain('beluga_memory');
  });

  it('reaches Codex in its developer instructions, with its tools over stdio', async () => {
    const codex = new FakeCodex();
    await createCodexBackend({ cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect }).run(input({ memoryBrief: memory.brief, memoryTools: memory.tools }));
    const [start] = codex.sent('thread/start');
    expect(start!.developerInstructions).toContain('MARKER-MEMORY-4411');
    expect(Object.keys(start!.config as object)).toContain('mcp_servers.beluga_memory');
  });

  it('reaches OpenCode in its instructions file, with its tools over stdio', async () => {
    const oc = new ScriptedOpenCode();
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'beluga-memory-oc-'));
    let instructions = '';
    const run = input({
      memoryBrief: memory.brief,
      memoryTools: memory.tools,
      place: { cwd, additionalDirectories: [], autoEdit: true, onSession: () => undefined },
      onEvent: (k) => {
        if (k === 'text' && !instructions) instructions = readFileSync((oc.lastConfig().instructions as string[])[0]!, 'utf8');
      },
    });
    await createOpenCodeBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: oc.connect, resolve: async () => undefined }).run(run);
    expect(instructions).toContain('MARKER-MEMORY-4411');
    expect((oc.sent('session/new')[0]!.mcpServers as Array<{ name: string }>).map((s) => s.name)).toContain('beluga_memory');
  });
});

describe('who gets the memory', () => {
  const host = () => {
    const inputs: AgentRunInput[] = [];
    const agent: AgentBackend = {
      async run(input) {
        inputs.push(input);
        return 'ok';
      },
    };
    const memory = memoryForRun(new MemoryStore(tempHome()), undefined);
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
      memory: () => memory,
    });
    const ask = (from: string, requestId: string): Promise<void> => h.onAgentRequest(from, { kind: 'agent_request', requestId, prompt: 'hi', viaAgent: false, channel: 'room', urgent: false, plan: false });
    return { ask, inputs };
  };

  it('your own run gets the brief and the tools', async () => {
    const t = host();
    await t.ask('me', 'r1');
    await waitFor(() => t.inputs.length === 1);
    expect(t.inputs[0]?.memoryBrief).toContain('Beluga’s memory');
    expect(t.inputs[0]?.memoryTools).toBeDefined();
  });

  it('a run for a friend never gets either', async () => {
    const t = host();
    await t.ask('bob', 'r1');
    await waitFor(() => t.inputs.length === 1);
    expect(t.inputs[0]?.memoryBrief).toBeUndefined();
    expect(t.inputs[0]?.memoryTools).toBeUndefined();
    expect(runInstructions(t.inputs[0]!, 'kay')).not.toContain('Beluga’s memory');
  });
});
