import { type RunEnd, RunFailedError, classifyRun, resetFromText } from '../../../shared/run-failure.js';
import { CodexRpcError } from '../codex/rpc.js';
import type { ConfigOption } from '../opencode/acp.js';
import type { RuntimeStatus } from '../types.js';

/** Claude's aliases and a Beluga default mean nothing to an ACP agent: those run on its own choice. */
const CLAUDE_ALIASES = /^(default|opus|sonnet|haiku|best|opusplan)(\[1m\])?$/i;

/** A model an ACP agent may know (`gemini-3.8-flash`), or undefined for its own. */
export function acpModel(model: string | undefined): string | undefined {
  if (!model || CLAUDE_ALIASES.test(model.trim()) || model.includes('[') || model.includes('/')) return undefined;
  return model.trim();
}

/** A session mode's value by what it's for: `plan`, or `default` (asks before edits and commands, so Beluga judges each). */
export function modeValue(options: readonly ConfigOption[], name: 'plan' | 'default'): string | undefined {
  return options.find((o) => o.id === 'mode')?.options.find((o) => o.value === name)?.value;
}

/** A run's end from what failed: an ACP error (its code kept), or a message. */
export const acpEnd = (err: unknown, stderr: readonly string[]): RunEnd & { readonly cause: unknown } => ({ error: err instanceof Error ? err.message : String(err), stderr, cause: err });

/** ACP's error code for "sign in first" (`auth_required`). */
export const ACP_AUTH_REQUIRED = -32000;
/** Words for "nobody is signed in", when an agent says so without ACP's code. */
export const ACP_SIGNED_OUT = /auth(entication)?[ _]required|not (logged|signed) in|unauthenticated|log ?in (with|first)|\b401\b|invalid_grant/i;

/** Signed out, as an ACP error says it: by its code, else its words. */
export const acpSignedOut = (err: unknown): boolean => (err instanceof CodexRpcError && err.code === ACP_AUTH_REQUIRED) || ACP_SIGNED_OUT.test(err instanceof Error ? err.message : String(err));

/**
 * A failed run, told as the runtime's own (not Claude Code's): a sign-in (ACP's own code), your
 * plan's limit (`limit`: the agent's own words for it, never a stderr line's), else as every
 * runtime's is (classifyRun).
 */
export function acpFailure(end: RunEnd & { readonly cause?: unknown }, runtime: string, limit?: RegExp): Error {
  const failure = classifyRun(end);
  const said = [end.error, end.result].filter(Boolean).join('\n');
  if (acpSignedOut(end.cause ?? said)) return new RunFailedError({ kind: 'signed_out', detail: failure.detail, runtime });
  if (limit?.test(said)) {
    const resetsAt = resetFromText(said);
    return new RunFailedError({ kind: 'usage_limit', ...(resetsAt ? { resetsAt } : {}), detail: failure.detail, runtime });
  }
  return new RunFailedError({ ...failure, runtime });
}

/** What an agent is told after a turn it ended silently on a declined step: why, and to answer. */
export const declinedNote = (why: readonly string[]): string => `Beluga declined that step: ${[...new Set(why)].join(' ')} Carry on without it: answer the person now, saying what you couldn't do.`;

/** The session's options a picker reads: its models, and the thinking levels the current one takes. */
export function modelRows(options: readonly ConfigOption[] | undefined): RuntimeStatus['models'] {
  const model = options?.find((o) => o.id === 'model' || o.category === 'model');
  const levels = options?.find((o) => o.id === 'thought_level' || o.category === 'thought_level')?.options.map((o) => o.value) ?? [];
  return (model?.options ?? []).map((o) => ({ value: o.value, label: o.name, description: o.description ?? '', ...(o.value === model?.currentValue && levels.length ? { efforts: levels } : {}) }));
}
