import { claudeLaunch } from '../../agent/runtime/claude/launch-args.js';
import { codexLaunch } from '../../agent/runtime/codex/launch-args.js';
import type { ArgsRuntime } from '../../shared/agent-args.js';

/** One chat's run, as permissionRank reads it. */
export interface RankInput {
  readonly planMode: boolean;
  /** Where it runs (AgentPlace): a look-only chat has `askOnly`. */
  readonly place?: { readonly askOnly?: unknown; readonly autoEdit?: boolean } | undefined;
  /** The runtime that answers in the chat ('claude', 'codex', …). */
  readonly runtime: string;
  /** Your launch flags per runtime (Settings › Agents › Launch flags). */
  readonly flags: Readonly<Partial<Record<ArgsRuntime, readonly string[]>>>;
}

const CLAUDE_RANK: Readonly<Record<string, number>> = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };

/**
 * How far a chat's run can act on its own (BLG-304), for send_to_chat's mode_wider check: a message
 * may not ask a chat to go further than its sender can.
 *
 * 0: it only looks (plan mode, a look-only chat). 1: it asks before it edits. 2: it edits on its own.
 * 3: it never asks (your launch flags for its runtime skip the asks, or set a Codex approval mode
 * or sandbox that never asks).
 */
export function permissionRank(run: RankInput): number {
  if (run.planMode || !run.place || run.place.askOnly) return 0;
  const base = run.place.autoEdit ? 2 : 1;
  if (run.runtime === 'claude') {
    const mode = claudeLaunch(run.flags.claude ?? [], { plan: false, autoEdit: base === 2 }).permissionMode;
    return CLAUDE_RANK[mode] ?? base;
  }
  if (run.runtime === 'codex') {
    const codex = codexLaunch(run.flags.codex ?? []);
    if (codex.fullAccess || codex.neverAsks) return 3;
  }
  return base;
}
