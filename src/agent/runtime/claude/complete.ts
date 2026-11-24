import { query } from '@anthropic-ai/claude-agent-sdk';
import { CompletionError, type CompletionRequest } from '../types.js';
import { PromptQueue } from './live-run.js';
import { ownerMcpServers } from './owner-mcp.js';
import { sdkServers } from './sdk-mount.js';
import { claudeExecutable } from '../../claude-code.js';

/**
 * claude.ai connectors (Google Drive) come only with your user settings and a loose MCP config;
 * your CLAUDE.md files stay out so they don't steer the answer. Every tool is still vetted.
 */
const connectorSettings = () => ({ settingSources: ['user' as const], env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } });

/**
 * A side call on Claude Code (agent/side-calls.ts): one model turn or a few, no saved session, no
 * settings files (a friend with :rw access could plant hooks there), only the tools it's given.
 */
export async function claudeComplete(req: CompletionRequest, claudePath?: string): Promise<string> {
  const abortController = new AbortController();
  const stop = (): void => abortController.abort();
  if (req.signal?.aborted) stop();
  req.signal?.addEventListener('abort', stop, { once: true });
  // Pictures go in as content blocks, which needs the prompt streamed in (so do in-process tools).
  let prompt: string | PromptQueue = req.prompt;
  if (req.images) {
    prompt = new PromptQueue();
    prompt.push(req.images.length ? [...req.images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mime as 'image/png', data: img.data } })), { type: 'text' as const, text: req.prompt }] : req.prompt);
    prompt.close();
  }
  const vet = req.vetTool;
  const pick = vet ? req.ownerMcp : undefined;
  const own = pick ? Object.fromEntries(Object.entries(ownerMcpServers(req.cwd)).filter(([name]) => pick(name))) : {};
  const connectors = Boolean(pick && req.connectors);
  const mounted = req.suites || pick ? { ...own, ...(req.suites ? sdkServers(req.suites) : {}) } : undefined;
  try {
    const q = query({
      prompt,
      options: {
        cwd: req.cwd,
        ...(req.model ? { model: req.model } : {}),
        tools: [...(req.tools ?? [])],
        ...(mounted ? { mcpServers: mounted, strictMcpConfig: !connectors } : {}),
        ...(req.allowedTools ? { allowedTools: [...req.allowedTools] } : {}),
        maxTurns: req.maxTurns ?? 1,
        ...(connectors ? connectorSettings() : { settingSources: [] }),
        persistSession: false,
        abortController,
        systemPrompt: req.system,
        ...(vet
          ? {
              hooks: {
                PreToolUse: [
                  {
                    hooks: [
                      async (h) => {
                        if (h.hook_event_name !== 'PreToolUse') return {};
                        const { allow, reason } = vet(h.tool_name, (h.tool_input ?? {}) as Record<string, unknown>);
                        return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: allow ? ('allow' as const) : ('deny' as const), permissionDecisionReason: reason } };
                      },
                    ],
                  },
                ],
              },
            }
          : {}),
        ...claudeExecutable(claudePath),
      },
    });
    for await (const msg of q) {
      if (msg.type !== 'result') continue;
      if (msg.subtype === 'success' && !msg.is_error) return msg.result;
      throw new CompletionError(msg.subtype === 'error_max_turns' ? 'max_turns' : 'failed');
    }
    throw new CompletionError('no_answer');
  } finally {
    req.signal?.removeEventListener('abort', stop);
  }
}
