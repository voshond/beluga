import { ToolHost } from '../../tool-host.js';
import { CompletionError, type CompletionRequest } from '../types.js';
import { type ConfigOption, type PermissionRequest, type PromptResponse, type SessionResponse, type SessionUpdate, permissionAnswer } from '../opencode/acp.js';
import { sidePrompt } from '../opencode/complete.js';
import { httpServers } from '../copilot/run-parts.js';
import { type AgyConnect, spawnAgy } from './connection.js';
import { agyModel, declinedNote } from './run-parts.js';
import { dropAgySession } from './sessions.js';
import { agyCalls, agyInput, agyTool, belugaToolOf } from './tools.js';

export interface AgySideDeps {
  readonly connect?: AgyConnect;
  readonly bin?: string;
  readonly toolHost?: ToolHost;
  /** Drops the conversation afterwards (tests: a fake). */
  readonly drop?: (sessionId: string) => Promise<unknown>;
}

let host: ToolHost | undefined;

/**
 * A side call on Antigravity (agent/side-calls.ts): one prompt in a conversation of its own
 * (dropped after), its request marked as input (sidePrompt: Antigravity keeps its own system
 * prompt). It may use only the tools it was given, each one asked about (vetTool) when Antigravity
 * asks; Beluga's suites, when given, are mounted for this call alone. A model of Antigravity's
 * when one was named; 'haiku' (small and fast) is its default model at its lowest thinking level.
 */
export async function agyComplete(req: CompletionRequest, deps: AgySideDeps = {}): Promise<string> {
  if (req.signal?.aborted) throw new Error('aborted');
  const mounted = req.suites
    ? await (deps.toolHost ?? (host ??= new ToolHost())).mount(req.suites, async (name, input) => {
        const verdict = req.vetTool?.(name, input);
        return verdict && !verdict.allow ? verdict.reason : undefined;
      })
    : undefined;
  const suites = Object.keys(mounted?.http ?? {});
  const ours = mounted?.tools ?? new Set<string>();
  const conn = await (deps.connect ?? spawnAgy)({ cwd: req.cwd, look: true, ...(deps.bin ? { bin: deps.bin } : {}) }).catch(() => undefined);
  if (!conn) {
    mounted?.close();
    throw new CompletionError('failed');
  }
  const stop = (): void => void conn.proc.kill();
  req.signal?.addEventListener('abort', stop, { once: true });
  let sid = '';
  let text = '';
  /** Why this call's steps were turned down (Antigravity ends its turn silently on one). */
  const declined: string[] = [];
  const calls = new Map<string, { tool: string; raw: Record<string, unknown> }>();
  try {
    if (req.signal?.aborted) throw new Error('aborted');
    const { rpc } = conn;
    rpc.onNotification((method, params) => {
      if (method !== 'session/update' || !sid || params.sessionId !== sid) return;
      const u = params.update as SessionUpdate;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' && u.content.text) text += u.content.text;
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const known = calls.get(u.toolCallId) ?? { tool: agyTool(u), raw: {} };
        known.raw = { ...known.raw, ...agyInput(u) };
        calls.set(u.toolCallId, known);
      }
      // A step starts: what was said before it wasn't the answer.
      if (u.sessionUpdate === 'tool_call') text = '';
    });
    rpc.onRequest(async (method, params) => {
      if (method !== 'session/request_permission') throw new Error(`${method} isn’t supported in Beluga`);
      const p = params as unknown as PermissionRequest;
      const known = calls.get(p.toolCall.toolCallId) ?? { tool: agyTool(p.toolCall), raw: {} };
      const raw = { ...known.raw, ...agyInput(p.toolCall) };
      if (belugaToolOf(known.tool, suites, ours)) return permissionAnswer(p, true);
      for (const c of agyCalls(known.tool, raw, req.cwd, suites, ours)) {
        if (!req.tools?.includes(c.name)) return (declined.push(`${c.name} isn’t one of this request’s tools.`), permissionAnswer(p, false));
        const verdict = req.vetTool?.(c.name, c.input);
        if (verdict && !verdict.allow) return (declined.push(verdict.reason || `${c.name} isn’t allowed here.`), permissionAnswer(p, false));
      }
      return permissionAnswer(p, true);
    });
    const session = await rpc.request<SessionResponse>('session/new', { cwd: req.cwd, mcpServers: mounted ? httpServers(mounted.http) : [] });
    sid = session.sessionId!;
    const options: readonly ConfigOption[] = session.configOptions ?? [];
    const set = async (id: string, value: string | undefined): Promise<void> => {
      const option = options.find((o) => o.id === id);
      if (value && option && option.currentValue !== value && option.options.some((o) => o.value === value)) await rpc.request('session/set_config_option', { sessionId: sid, configId: id, value }).catch(() => undefined);
    };
    await set('model', agyModel(req.model));
    if (req.model && /haiku/i.test(req.model)) await set('thought_level', 'low');
    const blocks = [...(req.images ?? []).map((img) => ({ type: 'image' as const, mimeType: img.mime, data: img.data })), { type: 'text' as const, text: sidePrompt(req) }];
    const ask = (prompt: typeof blocks | Array<{ type: 'text'; text: string }>): Promise<PromptResponse> => Promise.race([rpc.request<PromptResponse>('session/prompt', { sessionId: sid, prompt }), rpc.closed.then(() => Promise.reject(new Error('Antigravity stopped')))]);
    let res = await ask(blocks);
    if (!text.trim() && res.stopReason === 'end_turn' && declined.length) res = await ask([{ type: 'text', text: declinedNote(declined) }]);
    if (req.signal?.aborted) throw new Error('aborted');
    if (res.stopReason === 'max_turn_requests') throw new CompletionError('max_turns');
    if (res.stopReason !== 'end_turn' && res.stopReason !== 'max_tokens') throw new CompletionError('failed');
    if (!text.trim()) throw new CompletionError('no_answer');
    return text.trim();
  } catch (err) {
    if (req.signal?.aborted) throw new Error('aborted');
    throw err instanceof CompletionError ? err : new CompletionError('failed');
  } finally {
    req.signal?.removeEventListener('abort', stop);
    mounted?.close();
    await conn.proc.kill();
    if (sid) void (deps.drop ?? dropAgySession)(sid).catch(() => undefined);
  }
}
