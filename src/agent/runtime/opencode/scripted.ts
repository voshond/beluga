import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { scriptedWords } from '../codex/scripted.js';
import { CodexRpc } from '../codex/rpc.js';
import type { ConfigOption } from './acp.js';
import { type OpenCodeConnect, type OpenCodeConnection, acpHandshake } from './connection.js';

/**
 * A scripted `opencode acp` in memory, speaking ACP in the shapes OpenCode 1.19 sends (recorded from
 * a real one: a call's `tool_call` with its tool id as title, its input in the update after, every
 * call asking `session/request_permission` the way Beluga's config makes it), following the
 * conformance script (tests/runtime-conformance.ts): `P` is answered `echo: P` after running
 * `echo P`; `ask…` too (every command asks; declined: `denied: P`); `wait…` works until cancelled;
 * `read <file>` reads a file (its path only in the update, as OpenCode's read sends it); `board`
 * calls one of Beluga's tools (beluga_board_task_get);
 * `/compact` summarises; `limit` and `retry` hit a provider error that OpenCode keeps retrying. Sessions outlive a connection, as OpenCode keeps them.
 */
export class ScriptedOpenCode {
  /** `stepMs`: a pause before each step ends, so a screen sees it run (the demo); none in tests. */
  constructor(private readonly opts: { readonly stepMs?: number } = {}) {}

  /** Every request each connection got, in order (for assertions). */
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** Each connection's environment (its OPENCODE_CONFIG_CONTENT) and whether it was started `--pure`. */
  readonly starts: Array<{ readonly env: Readonly<Record<string, string | undefined>>; readonly pure: boolean; readonly cwd: string }> = [];
  readonly sessions = new Set<string>();
  /** Permission answers it got, in order. */
  readonly answers: unknown[] = [];
  connections = 0;
  /** Its models: the first is its default. */
  models = [
    { value: 'opencode/big-pickle', name: 'OpenCode/Big Pickle', efforts: [] as string[] },
    { value: 'anthropic/claude-sonnet-4-5', name: 'Anthropic/Claude Sonnet 4.5', efforts: ['low', 'high', 'max'] },
    { value: 'opencode/glm-5.3-flash-free', name: 'OpenCode/GLM-5.3-Flash Free', efforts: [] as string[] },
  ];
  /** Its own commands (built-ins, and the skills it loaded). */
  commands = ['init', 'review', 'api-design'];

  readonly connect: OpenCodeConnect = async ({ env, pure, cwd }) => {
    this.connections++;
    this.starts.push({ env: { ...(env ?? {}) }, pure: Boolean(pure), cwd });
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const send = (msg: object): void => void (toClient.writable && toClient.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`));
    const update = (sessionId: string, u: object): void => send({ method: 'session/update', params: { sessionId, update: u } });
    let alive = true;
    const logs: Array<(line: string) => void> = [];
    /** A log line as OpenCode's `--print-logs` writes it. */
    const log = (sid: string, error: string, small = false): void => {
      for (const fn of logs) fn(`timestamp=${new Date().toISOString()} level=ERROR message="stream error" providerID=opencode modelID=big-pickle session.id=${sid} small=${small} agent=${small ? 'title' : 'build'} mode=primary error.error="${error}"`);
    };
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => (exit = resolve));
    let next = 1000;
    const asked = new Map<number, (result: unknown) => void>();
    const ask = (method: string, params: object): Promise<unknown> =>
      new Promise((resolve) => {
        const id = ++next;
        asked.set(id, resolve);
        send({ id, method, params });
      });
    /** Each session's chosen options. */
    const chosen = new Map<string, { model: string; effort?: string; mode: string }>();
    /** The running prompt: how to cancel it. */
    let running: { sessionId: string; cancel: () => void } | undefined;
    let used = 12_000;
    // Agents its config adds (Beluga's side-call agent) are modes too, as OpenCode lists its primary agents.
    const config = JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? '{}') as { agent?: Record<string, { mode?: string }> };
    const modes = Object.entries(config.agent ?? {}).filter(([, a]) => a.mode === 'primary').map(([name]) => ({ value: name, name }));

    const optionsOf = (sid: string): ConfigOption[] => {
      const c = chosen.get(sid)!;
      const model = this.models.find((m) => m.value === c.model)!;
      return [
        { id: 'model', category: 'model', currentValue: c.model, options: this.models.map((m) => ({ value: m.value, name: m.name })) },
        ...(model.efforts.length ? [{ id: 'effort', category: 'thought_level', currentValue: c.effort ?? 'default', options: [...model.efforts, 'default'].map((e) => ({ value: e, name: e })) }] : []),
        { id: 'mode', category: 'mode', currentValue: c.mode, options: [{ value: 'build', name: 'build' }, { value: 'plan', name: 'plan' }, ...modes] },
      ];
    };
    const open = (sid: string): { sessionId: string; configOptions: ConfigOption[] } => {
      this.sessions.add(sid);
      if (!chosen.has(sid)) chosen.set(sid, { model: this.models[0]!.value, mode: 'build' });
      setTimeout(() => update(sid, { sessionUpdate: 'available_commands_update', availableCommands: this.commands.map((name) => ({ name, description: name })) }), 0);
      return { sessionId: sid, configOptions: optionsOf(sid) };
    };
    const pause = (): Promise<void> => new Promise((r) => setTimeout(r, this.opts.stepMs ?? 2));

    /** One command step: its call, its input in the update after, asked about, then run (or not). */
    const command = async (sid: string, words: string): Promise<'ran' | 'declined'> => {
      const id = `call_${randomUUID().slice(0, 8)}`;
      update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: 'bash', kind: 'execute', status: 'pending', locations: [], rawInput: { cwd } });
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', kind: 'execute', title: `echo ${words}`, rawInput: { command: `echo ${words}`, cwd } });
      const verdict = (await ask('session/request_permission', permission(sid, id, `echo ${words}`, 'execute', { command: `echo ${words}` }))) as { outcome?: { outcome?: string; optionId?: string } };
      this.answers.push(verdict);
      if (verdict?.outcome?.optionId !== 'once') {
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', title: `echo ${words}`, content: [{ type: 'content', content: { type: 'text', text: 'The user rejected permission to use this specific tool call.' } }] });
        return 'declined';
      }
      await pause();
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', title: `echo ${words}`, content: [{ type: 'content', content: { type: 'text', text: `${words}\n` } }], rawOutput: { output: `${words}\n`, metadata: { exit: 0 } } });
      return 'ran';
    };

    const say = (sid: string, text: string): void => {
      // In chunks, as OpenCode streams it.
      for (const part of text.match(/.{1,6}/gs) ?? []) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } });
    };
    const done = (sid: string, out: number): object => {
      used += 400;
      update(sid, { sessionUpdate: 'usage_update', used, size: 200_000, cost: { amount: used / 1_000_000, currency: 'USD' } });
      return { stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: out, totalTokens: used, cachedReadTokens: 100 } };
    };

    const prompt = async (sid: string, blocks: ReadonlyArray<{ type: string; text?: string }>): Promise<object> => {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      // A side call's request is its <input> (complete.ts sidePrompt); a run's, the prompt's last line.
      const input = /<input>\n([\s\S]*?)\n<\/input>/.exec(text);
      const words = input ? input[1]!.trim() : scriptedWords(text);
      if (words === '/compact') {
        say(sid, '## Summary\nWhat was done so far.');
        used = 900;
        update(sid, { sessionUpdate: 'usage_update', used, size: 200_000, cost: { amount: 0.001, currency: 'USD' } });
        return { stopReason: 'end_turn' };
      }
      if (/^(limit|retry)\b/.test(words)) {
        // The provider says no, and OpenCode retries: over ACP nothing comes; its log says why, each time.
        log(sid, 'AI_APICallError: Title model busy', true);
        const error = words.startsWith('limit') ? 'AI_APICallError: Free usage limit reached. Subscribe to OpenCode Go to keep going' : 'AI_APICallError: Too many requests';
        const every = setInterval(() => log(sid, error), 5);
        log(sid, error);
        await new Promise<void>((resolve) => (running = { sessionId: sid, cancel: resolve }));
        clearInterval(every);
        running = undefined;
        return { stopReason: 'cancelled' };
      }
      if (/^wait\b/.test(words)) {
        const id = `call_${randomUUID().slice(0, 8)}`;
        update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: 'bash', kind: 'execute', status: 'pending', locations: [], rawInput: { cwd } });
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', kind: 'execute', title: 'sleep 600', rawInput: { command: 'sleep 600', cwd } });
        await new Promise<void>((resolve) => (running = { sessionId: sid, cancel: resolve }));
        running = undefined;
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', title: 'sleep 600', content: [{ type: 'content', content: { type: 'text', text: 'Interrupted' } }] });
        return { stopReason: 'cancelled' };
      }
      const read = /^read (\S+)/.exec(words);
      if (read) {
        const id = `call_${randomUUID().slice(0, 8)}`;
        const file = read[1]!;
        update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: 'read', kind: 'read', status: 'pending', locations: [], rawInput: {} });
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', kind: 'read', title: 'read', locations: [{ path: file }], rawInput: { filePath: file } });
        // The read's permission request says nothing of the file (as OpenCode 1.19's doesn't).
        const verdict = (await ask('session/request_permission', permission(sid, id, 'read', 'read', {}))) as { outcome?: { optionId?: string } };
        this.answers.push(verdict);
        const ok = verdict?.outcome?.optionId === 'once';
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', title: file, content: [{ type: 'content', content: { type: 'text', text: ok ? 'file contents' : 'The user rejected permission to use this specific tool call.' } }] });
        say(sid, ok ? `read: ${file}` : `denied: ${words}`);
        return done(sid, 8);
      }
      if (/^board\b/.test(words)) {
        // One of Beluga's own tools (an MCP server's, named `<server>_<tool>`): it asks too.
        const id = `call_${randomUUID().slice(0, 8)}`;
        update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: 'beluga_board_task_get', kind: 'other', status: 'pending', locations: [], rawInput: {} });
        const verdict = (await ask('session/request_permission', permission(sid, id, 'beluga_board_task_get', 'other', {}))) as { outcome?: { optionId?: string } };
        this.answers.push(verdict);
        const ok = verdict?.outcome?.optionId === 'once';
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: ok ? 'BLG-1: a task' : 'rejected' } }] });
        say(sid, ok ? 'board: BLG-1' : `denied: ${words}`);
        return done(sid, 6);
      }
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Running it.' } });
      const ran = await command(sid, words);
      say(sid, ran === 'ran' ? `echo: ${words}` : `denied: ${words}`);
      return done(sid, 12);
    };

    const answer = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const sid = String(params.sessionId ?? '');
      switch (method) {
        case 'initialize':
          return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { fork: {}, resume: {}, close: {}, list: {} } }, agentInfo: { name: 'OpenCode', version: '1.19.5' } };
        case 'session/new':
          return open(`ses_${randomUUID().replace(/-/g, '').slice(0, 24)}`);
        case 'session/resume':
          if (!this.sessions.has(sid)) throw new Error(`Session not found: ${sid}`);
          return { configOptions: open(sid).configOptions };
        case 'session/fork': {
          if (!this.sessions.has(sid)) throw new Error(`Session not found: ${sid}`);
          const forked = `ses_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
          chosen.set(forked, { ...chosen.get(sid)! });
          return open(forked);
        }
        case 'session/set_config_option': {
          const c = chosen.get(sid)!;
          const value = String(params.value);
          if (params.configId === 'model') c.model = value;
          else if (params.configId === 'effort') c.effort = value;
          else if (params.configId === 'mode') c.mode = value;
          return { configOptions: optionsOf(sid) };
        }
        case 'session/prompt':
          return prompt(sid, (params.prompt ?? []) as Array<{ type: string; text?: string }>);
        default:
          throw new Error(`Method not found: ${method}`);
      }
    };

    readline.createInterface({ input: toServer }).on('line', (line) => {
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (!msg.method && msg.id !== undefined) return void asked.get(msg.id)?.(msg.result);
      if (!msg.method) return;
      this.requests.push({ method: msg.method, params: msg.params ?? {} });
      if (msg.method === 'session/cancel') return void (running?.sessionId === msg.params?.sessionId && running?.cancel());
      if (msg.id === undefined) return;
      answer(msg.method, msg.params ?? {}).then(
        (result) => send({ id: msg.id, result }),
        (err: Error) => send({ id: msg.id, error: { code: -32602, message: err.message } }),
      );
    });

    const rpc = new CodexRpc(toClient, toServer, { name: 'OpenCode', jsonrpc: true });
    const proc = {
      pid: 4343,
      alive: () => alive,
      exited,
      kill: async () => {
        if (!alive) return;
        alive = false;
        running?.cancel();
        toClient.end();
        toServer.end();
        exit();
      },
    };
    const init = await acpHandshake(rpc);
    const conn: OpenCodeConnection = { rpc, proc, init, stderr: () => [], onLog: (fn) => void logs.push(fn) };
    return conn;
  };

  /** The params of every request of `method`. */
  sent(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }

  /** The config Beluga gave the last connection (its OPENCODE_CONFIG_CONTENT). */
  lastConfig(): Record<string, unknown> {
    return JSON.parse(this.starts.at(-1)?.env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>;
  }
}

const permission = (sessionId: string, toolCallId: string, title: string, kind: string, rawInput: object): object => ({
  sessionId,
  toolCall: { toolCallId, title, kind, status: 'pending', locations: [], rawInput },
  options: [
    { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
  ],
});
