import { describe, expect, it, vi } from 'vitest';
import type { CodexConnect } from '../src/agent/runtime/codex/app-server.js';
import { CodexMcp, shortMcpError, toCodexRow } from '../src/agent/runtime/codex/mcp.js';
import { createCodexBackend } from '../src/agent/runtime/codex/runner.js';
import { GatePasses, mcpToolCallOf } from '../src/agent/runtime/codex/tool-questions.js';
import { routedBackend } from '../src/agent/runtime/router.js';
import type { ToolGate, ToolHost } from '../src/agent/tool-host.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { FakeCodex } from './fake-codex.js';
import { room } from './runtime-conformance.js';

const cwd = process.cwd();
const backend = (codex: FakeCodex): AgentBackend => createCodexBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect });
const mcpOf = (codex: FakeCodex, signInMs?: number): CodexMcp => new CodexMcp((dir) => codex.connect({ cwd: dir }), signInMs ? { signInMs } : {});

function input(prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return { prompt, requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true, sandbox: true, ...extra };
}

describe('Codex MCP servers in Settings (BLG-518)', () => {
  it('lists your Codex servers with how each is, its tools, where it comes from, and what you can do', async () => {
    const codex = new FakeCodex();
    const rows = await backend(codex).mcpServers!([]);
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ['figma', 'needs-auth'],
      ['github', 'connected'],
      ['linear', 'connected'],
      ['sentry', 'failed'],
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.figma).toMatchObject({ from: 'user', canSignIn: true, canTurnOff: true });
    expect(by.github).toMatchObject({ from: 'user', tools: 3, canSignIn: false, canTurnOff: true });
    // A plugin's: no config entry of its own, so no switch.
    expect(by.linear).toMatchObject({ from: 'plugin', where: 'linear', tools: 1 });
    expect(by.linear!.canTurnOff).toBeUndefined();
    expect(by.sentry).toMatchObject({ error: 'No such file or directory (os error 2)', canSignIn: false });
    // Asked without a thread, for tools and sign-in only; its app-server closed after.
    expect(codex.sent('mcpServerStatus/list')).toEqual([{ detail: 'toolsAndAuthOnly' }]);
  });

  it('turns one off and on in config.toml, and a turned-off one shows so', async () => {
    const codex = new FakeCodex();
    const b = backend(codex);
    expect(await b.mcpSetEnabled!([], 'github', false)).toEqual({ ok: true });
    expect(codex.sent('config/value/write')).toEqual([{ keyPath: 'mcp_servers.github.enabled', value: false, mergeStrategy: 'upsert', filePath: '/home/.codex/config.toml' }]);
    expect((await b.mcpServers!([])).find((r) => r.name === 'github')).toMatchObject({ status: 'disabled', canTurnOff: true });
    expect(await b.mcpSetEnabled!([], 'github', true)).toEqual({ ok: true });
    expect((await b.mcpServers!([])).find((r) => r.name === 'github')?.status).toBe('connected');
    // A plugin's, or a name that isn't a plain TOML key, isn't written.
    expect(await b.mcpSetEnabled!([], 'linear', false)).toMatchObject({ error: expect.stringContaining('plugin') });
    expect(await b.mcpSetEnabled!([], 'a.b', false)).toMatchObject({ error: expect.any(String) });
    expect(codex.sent('config/value/write')).toHaveLength(2);
  });

  it('signs in through Codex: the page for your browser, then connected once Codex says so', async () => {
    const codex = new FakeCodex();
    const b = backend(codex);
    const started = await b.mcpSignIn!([], 'figma');
    expect(started).toEqual({ url: expect.stringMatching(/^https:\/\/example\.com\/oauth\/figma\/authorize/) });
    expect(await b.mcpSignedIn!('figma')).toBe(true);
    expect(await b.mcpSignedIn!('figma')).toBeUndefined();
    expect((await b.mcpServers!([])).find((r) => r.name === 'figma')).toMatchObject({ status: 'connected', tools: 2, canSignIn: false });
  });

  it('says why a sign-in can’t start, and gives up on one you never finish', async () => {
    const codex = new FakeCodex();
    expect(await backend(codex).mcpSignIn!([], 'github')).toEqual({ error: 'OAuth login is only supported for streamable HTTP servers.' });
    codex.mcpLoginEnds = false;
    const mcp = mcpOf(codex);
    expect(await mcp.signIn(cwd, 'figma')).toHaveProperty('url');
    expect(await mcp.signedIn('figma')).toBe(false);
    codex.mcpLoginEnds = undefined;
    const slow = mcpOf(codex, 30);
    expect(await slow.signIn(cwd, 'figma')).toHaveProperty('url');
    expect(await slow.signedIn('figma')).toBe(false);
  });

  it('checks your servers with the variables your runs get, so a token saved in Beluga counts (#442)', async () => {
    const codex = new FakeCodex();
    const seen: Array<Readonly<Record<string, string | undefined>> | undefined> = [];
    const connect: CodexConnect = (o) => {
      seen.push(o.env);
      return codex.connect(o);
    };
    const asked: string[] = [];
    const ownEnv = (dir: string): Record<string, string> => (asked.push(dir), { GITHUB_PAT_TOKEN: 'saved-token' });
    const b = createCodexBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect, ownEnv });
    await b.mcpServers!([]);
    await b.mcpSignIn!([], 'figma');
    await b.mcpSignedIn!('figma');
    await b.mcpSetEnabled!([], 'github', true);
    expect(seen).toHaveLength(3);
    for (const env of seen) {
      // Your saved variables over Beluga's own environment, as a run's: PATH still finds what servers start.
      expect(env?.GITHUB_PAT_TOKEN).toBe('saved-token');
      expect(env?.PATH).toBe(process.env.PATH);
    }
    // Asked for the folder the check starts in (a project there brings its own variables).
    expect(new Set(asked)).toEqual(new Set([cwd]));
  });

  it("routes Settings' ask to the runtime named, and the default's without one", async () => {
    const codex = new FakeCodex();
    const claude = { run: vi.fn(), mcpServers: vi.fn(async () => [{ name: 'c', label: 'c', from: 'user' as const, status: 'connected' as const, canSignIn: false }]) } as unknown as AgentBackend;
    const routed = routedBackend(claude, 'claude', (id) => (id === 'codex' ? backend(codex) : undefined));
    expect((await routed.mcpServers!([])).map((r) => r.name)).toEqual(['c']);
    expect((await routed.mcpServers!([], 'codex')).map((r) => r.name)).toContain('figma');
    expect(await routed.mcpSetEnabled!([], 'c', false)).toHaveProperty('error');
  });

  it('gives your own Codex runs your servers, and switches every one off for a friend’s', async () => {
    const codex = new FakeCodex();
    await backend(codex).run(input('hello'));
    const own = codex.sent('thread/start')[0]!.config as Record<string, unknown>;
    expect(Object.keys(own).filter((k) => /^mcp_servers\.(figma|github|sentry)/.test(k))).toEqual([]);
    await backend(codex).run(input('hello', { viaAgent: true, vetTool: () => undefined }));
    const friend = codex.sent('thread/start')[1]!.config as Record<string, unknown>;
    expect(friend).toMatchObject({ 'mcp_servers.figma.enabled': false, 'mcp_servers.github.enabled': false, 'mcp_servers.sentry.enabled': false });
    // Beluga's own tools still reach both.
    expect(own['mcp_servers.beluga']).toBeDefined();
    expect(friend['mcp_servers.beluga']).toBeDefined();
  });

  it('maps Codex statuses as a real codex-cli 0.166 gives them', () => {
    // Recorded from `mcpServerStatus/list` against a temporary CODEX_HOME.
    expect(toCodexRow({ name: 'off', tools: {}, toolsError: null, authStatus: 'unsupported' }, { command: '/bin/cat', enabled: false }).status).toBe('disabled');
    expect(toCodexRow({ name: 'offline', httpOrigin: 'http://127.0.0.1:9', tools: {}, toolsError: 'MCP startup failed: x', authStatus: 'unknown' }, { url: 'http://127.0.0.1:9/mcp', enabled: true })).toMatchObject({ status: 'failed', canSignIn: false });
    expect(toCodexRow({ name: 'p', runtimeStatus: 'starting' }, undefined).status).toBe('pending');
    expect(toCodexRow({ name: 'q', runtimeStatus: 'authenticationRequired', httpOrigin: 'https://q' }, undefined)).toMatchObject({ status: 'needs-auth', canSignIn: true });
    expect(toCodexRow({ name: 'x', tools: {} }, { command: 'x' }, { project: '/work/app/.codex' })).toMatchObject({ from: 'project', where: 'app' });
    expect(
      shortMcpError(
        'MCP startup failed: handshaking with MCP server failed: Send message error Transport [codex_rmcp_client::tool_list_changes::ToolListChanges<rmcp::transport::worker::WorkerTransport<x>>] error: Client error: HTTP request failed: http/request failed: error sending request for url (http://127.0.0.1:9/mcp), when send initialize request: Send message error Transport [y] error: …',
      ),
    ).toBe('handshaking with MCP server failed: Client error: HTTP request failed: http/request failed: error sending request for url (http://127.0.0.1:9/mcp)');
  });
});

describe('Codex asks before an MCP tool call (BLG-242)', () => {
  /** A run with a tool server whose gate the scripted Codex calls, as the real stdio server does. */
  function gated(codex: FakeCodex) {
    let gate: ToolGate = async () => undefined;
    const toolHost = { mount: async (_suites: unknown, g: ToolGate) => ((gate = g), { token: 't', servers: { beluga: { type: 'stdio', command: 'x', args: [], env: {} } }, close: () => undefined }) } as unknown as ToolHost;
    const denials: Array<string | undefined> = [];
    codex.mcpCall = async (server, tool, args) => void denials.push(await gate(`mcp__${server}__${tool}`, { ...args, timeout_sec: 120 }));
    return { denials, gate: () => gate, b: createCodexBackend({ cwd, autoEdit: true, additionalDirectories: [], bridge: room, connect: codex.connect, toolHost }) };
  }
  const own = (answer: boolean, asked: string[], extra: Partial<AgentRunInput> = {}): Partial<AgentRunInput> => ({
    scope: 'full',
    canUseTool: async (name) => {
      asked.push(name);
      return answer;
    },
    ...extra,
  });

  it('an allowed tool is accepted, and one call asks you one time', async () => {
    const codex = new FakeCodex();
    const { b, denials, gate } = gated(codex);
    const asked: string[] = [];
    await b.run(input('mcp run_on_peer', own(true, asked)));
    expect(codex.approvals).toEqual([{ action: 'accept', content: {} }]);
    expect(asked).toEqual(['mcp__beluga__run_on_peer']);
    // The tool server's gate adds the schema's default, and still lets the call through without asking again.
    expect(denials).toEqual([undefined]);
    // The pass was for one call: a second call asks.
    await gate()('mcp__beluga__run_on_peer', { peer: 'mia', command: 'uptime', timeout_sec: 120 });
    expect(asked).toEqual(['mcp__beluga__run_on_peer', 'mcp__beluga__run_on_peer']);
  });

  it('a denied tool is declined, and the call never reaches the tool server', async () => {
    const codex = new FakeCodex();
    const { b, denials } = gated(codex);
    const asked: string[] = [];
    await b.run(input('mcp run_on_peer', own(false, asked)));
    expect(codex.approvals).toEqual([{ action: 'decline' }]);
    expect(asked).toHaveLength(1);
    expect(denials).toEqual([]);
  });

  it('a pass fits only the same name and arguments', () => {
    const passes = new GatePasses();
    passes.add('t', { a: 1, b: [{ c: 2, d: 3 }] });
    expect(passes.take('t', { a: 2 })).toBe(false);
    expect(passes.take('other', { a: 1, b: [{ c: 2, d: 3 }] })).toBe(false);
    expect(passes.take('t', { b: [{ d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(passes.take('t', { a: 1, b: [{ c: 2, d: 3 }] })).toBe(false);
  });

  it('another elicitation still fails, and asks nobody', async () => {
    const codex = new FakeCodex();
    const { b } = gated(codex);
    const asked: string[] = [];
    await b.run(input('question', own(true, asked)));
    expect(codex.approvals).toEqual([undefined]);
    expect(asked).toEqual([]);
  });

  it.each([
    ['another mode', { mode: 'url' }],
    ['no approval kind', { _meta: { tool_params: {} } }],
    ['fields to fill in', { requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } }],
    ['a server that is not the one named', { serverName: 'other' }],
    ['other words', { message: 'Please run "x"?' }],
  ])('a question with %s is not a tool call', (_why, change) => {
    const real = { serverName: 'beluga', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: {} }, message: 'Allow the beluga MCP server to run tool "x"?', requestedSchema: { type: 'object', properties: {} } };
    expect(mcpToolCallOf(real)).toEqual({ name: 'mcp__beluga__x', server: 'beluga', tool: 'x', args: {} });
    expect(mcpToolCallOf({ ...real, ...change })).toBeUndefined();
  });

  it('while planning, a tool call is declined, whoever would allow it', async () => {
    const codex = new FakeCodex();
    const { b } = gated(codex);
    const asked: string[] = [];
    await b.run(input('mcp run_on_peer', own(true, asked, { plan: true })));
    expect(codex.approvals).toEqual([{ action: 'decline' }]);
    expect(asked).toEqual([]);
  });

  it.each([
    ['a friend', { viaAgent: true }],
    ['a full-trust friend', { viaAgent: true, scope: 'full' as const }],
    ['a friend with limits', { vetTool: () => undefined }],
    ['a guest', { guest: true }],
  ])('the run of %s gets no more tools than before: the question still fails', async (_who, who) => {
    const codex = new FakeCodex();
    const { b, denials } = gated(codex);
    const asked: string[] = [];
    await b.run(input('mcp run_on_peer', { ...own(true, asked), scope: 'folder', ...who }));
    expect(codex.approvals).toEqual([undefined]);
    expect(asked).toEqual([]);
    expect(denials).toEqual([]);
  });
});
