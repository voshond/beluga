import type { AgentRuntime, RuntimeCapabilities } from '../types.js';
import type { ResolvedConfig } from './config.js';
import type { OpenCodeConnect } from './connection.js';
import { openCodeComplete } from './complete.js';
import { createOpenCodeBackend } from './runner.js';
import { openCodeStatus } from './status.js';

/** OpenCode through `opencode acp` (BLG-686): what it can and can't do of what Beluga asks. */
export const OPENCODE_CAPABILITIES: RuntimeCapabilities = {
  // Each of its tool calls asks Beluga first (config.ts), and your own runs are judged per call as
  // Claude's are. But your OpenCode plugins, and in newer OpenCode the rules you saved with "Always
  // allow" in its own app, can answer a call before Beluga is asked, and it has no sandbox to fall
  // back on: so no friends' tasks and no guests (safetyFor).
  canGateEveryTool: false,
  hasSandbox: false,
  // One prompt at a time: a message sent while it works waits for its own turn; Send now stops the turn (session/cancel).
  canSteer: false,
  canInterrupt: true,
  // Its own plan agent: looks, edits nothing, then the plan comes to you.
  hasPlanMode: true,
  // Its task tool's sub-agents, each a row (no background agents: a run ends when it answers).
  hasSubagents: true,
  hasBackgroundAgents: false,
  // Tokens and cost per turn; no plan windows (it runs on your providers' keys or its free models).
  hasUsage: true,
  canResume: true,
  canFork: true,
  // Its question tool can't reach you over ACP: it asks in its answer.
  canAskUser: false,
  // Its own /compact.
  hasCompaction: true,
  hasModelList: true,
  hasProcess: true,
  // It loads your Claude Code skills itself; custom commands are expanded for it (skills.ts).
  skills: 'native',
  promptImages: true,
  toolMounts: ['stdio'],
};

/** An OpenCode runtime; `connect` and `resolve` swap how it's reached and what config it finds (tests script them). */
export function createOpenCodeRuntime(deps: { readonly connect?: OpenCodeConnect; readonly resolve?: () => Promise<ResolvedConfig | undefined>; readonly status?: AgentRuntime['status'] } = {}): AgentRuntime {
  const side = deps.connect ? { connect: deps.connect, drop: async () => undefined } : {};
  return {
    id: 'opencode',
    label: 'OpenCode',
    capabilities: OPENCODE_CAPABILITIES,
    // `executablePath` is Claude Code's (the Mac app's pinned binary): never OpenCode's. OpenCode finds its own (findOpenCode, BELUGA_OPENCODE_PATH).
    create: ({ executablePath: _claudePath, ...opts }) => createOpenCodeBackend({ ...opts, ...(deps.connect ? { connect: deps.connect } : {}), ...(deps.resolve ? { resolve: deps.resolve } : {}) }),
    complete: (req) => openCodeComplete(req, side),
    status: deps.status ?? (() => openCodeStatus()),
  };
}

export const openCodeRuntime: AgentRuntime = createOpenCodeRuntime();
