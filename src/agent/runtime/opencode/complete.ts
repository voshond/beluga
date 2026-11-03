import { ToolHost } from '../../tool-host.js';
import { CompletionError, type CompletionRequest } from '../types.js';
import type { ConfigOption } from './acp.js';
import { SIDE_AGENT, sideConfig } from './config.js';
import { type OneShotDeps, oneShot } from './one-shot.js';
import { acpServers } from './runner.js';
import { belugaCalls, belugaTool } from './tools.js';

let host: ToolHost | undefined;

/** Words in a model's id or name that say it's a small, fast one (what Claude's 'haiku' asks for). */
const SMALL_MODEL = /\b(mini|nano|small|lite|flash|fast|haiku|lightning)\b/i;

/**
 * A side call's prompt as OpenCode gets it: its instructions in the message itself, the request
 * marked as input. OpenCode keeps its own coding-agent system prompt even for Beluga's agent, so
 * a request alone ("Add a dark mode toggle") reads as work to do, not something to name.
 */
export function sidePrompt(req: Pick<CompletionRequest, 'system' | 'prompt' | 'tools'>): string {
  const tools = req.tools?.length ? `use only these tools, and only if you need them: ${req.tools.join(', ')};` : 'do not use any tools;';
  return [`This is a one-off request from Beluga, not work in this folder: ${tools} answer in one reply as the instructions say.`, '', '<instructions>', req.system.trim(), '</instructions>', '', '<input>', req.prompt.trim(), '</input>'].join('\n');
}

/** The model a side call asks for, from what OpenCode offers: 'haiku' a small, fast one when there is one; else its default. */
export function sideModel(model: string | undefined, options: readonly ConfigOption[]): string | undefined {
  const list = options.find((o) => o.id === 'model');
  if (!list) return undefined;
  if (model?.includes('/')) return list.options.some((o) => o.value === model) ? model : undefined;
  if (!model || !/haiku/i.test(model)) return undefined;
  // The same provider as its default first: a small model of a provider you pay for, not someone else's.
  const provider = list.currentValue.split('/')[0];
  const small = list.options.filter((o) => SMALL_MODEL.test(`${o.value} ${o.name}`.replace(/[-_/]/g, ' ')));
  return (small.find((o) => o.value.startsWith(`${provider}/`)) ?? small[0])?.value;
}

/**
 * A side call on OpenCode (agent/side-calls.ts): one prompt in a session of its own (dropped after),
 * as an agent of Beluga's whose whole prompt is `system` and which may use only the tools it was
 * given, each one still asked about (vetTool) before it runs. Beluga's suites, when given, are
 * mounted for this call alone and vetted per call.
 */
export async function openCodeComplete(req: CompletionRequest, deps: OneShotDeps & { readonly toolHost?: ToolHost } = {}): Promise<string> {
  if (req.signal?.aborted) throw new Error('aborted');
  const mounted = req.suites
    ? await (deps.toolHost ?? (host ??= new ToolHost())).mount(req.suites, async (name, input) => {
        const verdict = req.vetTool?.(name, input);
        return verdict && !verdict.allow ? verdict.reason : undefined;
      })
    : undefined;
  const suites = Object.keys(mounted?.servers ?? {});
  try {
    const { text, res } = await oneShot(
      {
        cwd: req.cwd,
        config: sideConfig(req.system),
        blocks: [...(req.images ?? []).map((img) => ({ type: 'image' as const, mimeType: img.mime, data: img.data })), { type: 'text', text: sidePrompt(req) }],
        servers: mounted ? acpServers(mounted.servers) : [],
        mode: SIDE_AGENT,
        model: (options) => sideModel(req.model, options),
        judge: async ({ tool, raw }) => {
          if (belugaTool(tool, suites)) return undefined;
          for (const c of belugaCalls(tool, raw, req.cwd, suites)) {
            if (!req.tools?.includes(c.name)) return 'Not one of this call’s tools.';
            if ((c.name === 'Read' && !c.input.file_path) || (c.name === 'Bash' && !c.input.command)) return 'OpenCode didn’t say what this is for.';
            const verdict = req.vetTool?.(c.name, c.input);
            if (verdict && !verdict.allow) return verdict.reason;
          }
          return undefined;
        },
        ...(req.signal ? { signal: req.signal } : {}),
      },
      deps,
    );
    if (res.stopReason === 'max_turn_requests') throw new CompletionError('max_turns');
    if (res.stopReason !== 'end_turn' && res.stopReason !== 'max_tokens') throw new CompletionError('failed');
    if (!text) throw new CompletionError('no_answer');
    return text;
  } catch (err) {
    if (req.signal?.aborted) throw new Error('aborted');
    throw err instanceof CompletionError ? err : new CompletionError('failed');
  } finally {
    mounted?.close();
  }
}
