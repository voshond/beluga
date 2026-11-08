import { z } from 'zod';
import { EFFORTS } from '../shared/settings-schema.js';
import { tool, toolSuite } from './tool-kit.js';
import type { ThreadTools } from './types.js';

/**
 * Child threads as an agent's tools (server `beluga_threads`). A child is a normal chat with its own
 * harness. The server is bound to the calling chat, so no argument names the caller.
 */

export const THREAD_TOOL_NAMES = ['thread_start', 'thread_status', 'thread_message', 'thread_stop'].map((n) => `mcp__beluga_threads__${n}`);

const THREAD_ID = z.string().min(1).max(80).describe('The id that thread_start or thread_status returned');
const TEXT_MAX = 32_000;
/**
 * Codex asks for an approval on a tool with no hints, and Beluga's Codex runner refuses that request.
 * These tools stay inside your own chats and pass Beluga's own gate per call (agent/tool-host.ts).
 */
const CHANGES_ONLY_CHATS = { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } };
const READS = { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };

export function createThreadToolDefs(threads: ThreadTools) {
  return [
    tool(
      'thread_start',
      'Start a child thread: a new chat where another agent does one task. The result comes back to this chat when the turn of the child ends. You can end your turn after this call. The task must hold all the context that the child needs, because the child does not see this chat.',
      {
        task: z.string().min(1).max(TEXT_MAX).describe('The full task for the child'),
        title: z.string().min(1).max(80).optional().describe('A short name for the chat'),
        agent: z
          .object({
            runtime: z.string().min(1).max(32).describe('The harness. thread_status with no id lists the installed harnesses'),
            model: z.string().min(1).max(64).optional().describe('A model of that harness. thread_status with no id lists the models'),
            effort: z.enum(EFFORTS).optional(),
          })
          .optional()
          .describe('Who does the task. If you do not set this, the default agent of the person does it'),
        project: z.string().min(1).max(80).optional().describe('The project name. The default is the project of this chat. Your Mac has no project, so a thread from Your Mac must set this'),
        where: z.enum(['worktree', 'read']).optional().describe('worktree (default): a new git worktree and branch. read: a read-only chat in the folder of this chat'),
        base: z.string().min(1).max(200).optional().describe('The branch that a new worktree starts from. The default is the base of the project'),
        plan: z.boolean().optional().describe('true: the child plans first. If this chat is in plan mode, its children must also be in plan mode'),
        key: z.string().min(1).max(120).optional().describe('A request key. A second call from this chat with the same key returns the same thread and starts no second run'),
      },
      (a) => guarded(() => threads.start({ ...a, ...(a.agent ? { agent: a.agent } : {}) })),
      CHANGES_ONLY_CHATS,
    ),
    tool(
      'thread_status',
      'Show threads under this chat. With no id: all threads under this chat, and the installed harnesses with their models and steer support. With an id: the state, harness, times and last answer of that thread. States: queued, running, needs_you, done, failed, stopped, interrupted. With wait_sec, the call waits until a thread reaches a final state or needs_you. A timeout does not stop the work. A result that a wait returns does not come back again.',
      {
        id: THREAD_ID.optional(),
        wait_sec: z.number().int().min(1).max(600).optional().describe('How many seconds to wait. Do not set this to get the state now'),
      },
      (a) => guarded(() => threads.status({ ...(a.id ? { id: a.id } : {}), ...(a.wait_sec ? { waitSec: a.wait_sec } : {}) })),
      READS,
    ),
    tool(
      'thread_message',
      'Send a message to a thread under this chat. The result of that turn comes back to this chat. mode "queue" (default): the agent reads the message when its current turn ends. mode "steer": the agent gets the message now. A harness without steer support refuses steer.',
      {
        id: THREAD_ID,
        text: z.string().min(1).max(TEXT_MAX),
        mode: z.enum(['queue', 'steer']).optional().describe('queue (default), or steer to send it now'),
      },
      (a) => guarded(() => threads.message({ id: a.id, text: a.text, ...(a.mode ? { mode: a.mode } : {}) })),
      CHANGES_ONLY_CHATS,
    ),
    tool(
      'thread_stop',
      'Stop a thread under this chat and all threads under it, deepest first. A stopped chat stays. Use thread_message to continue it. No tool archives or deletes a thread: only a person can do that.',
      {
        id: THREAD_ID,
        reason: z.string().min(1).max(500).optional().describe('Why you stop it. The chat of the thread shows this'),
      },
      (a) => guarded(() => threads.stop({ id: a.id, ...(a.reason ? { reason: a.reason } : {}) })),
      CHANGES_ONLY_CHATS,
    ),
  ];
}

export function createThreadTools(threads: ThreadTools) {
  return toolSuite({ name: 'beluga_threads', version: '0.1.0', tools: createThreadToolDefs(threads) });
}

function guarded(fn: () => string | Promise<string>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return Promise.resolve()
    .then(fn)
    .then(
      (text) => ({ content: [{ type: 'text' as const, text }] }),
      (err: unknown) => ({ content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true }),
    );
}
