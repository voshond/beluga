import os from 'node:os';
import type { ConfigOption, SessionResponse } from '../opencode/acp.js';
import type { RuntimeStatus } from '../types.js';
import { CodexRpcError } from '../codex/rpc.js';
import { type AgyConnect, findAgy, spawnAgy } from './connection.js';
import { dropAgySession } from './sessions.js';

export const AGY_MISSING = 'Install the Antigravity CLI: curl -fsSL https://antigravity.google/cli/install.sh | bash';
export const AGY_SIGN_IN = 'Run agy in Terminal once to sign in with your Google account';

/** ACP's error code for "sign in first" (`auth_required`). */
export const ACP_AUTH_REQUIRED = -32000;
/** Its words for "nobody is signed in", when it says so without ACP's code. */
export const AGY_SIGNED_OUT = /auth(entication)?[ _]required|not (logged|signed) in|unauthenticated|log ?in (with|first)|\b401\b|invalid_grant/i;
/**
 * Its words when your plan's quota has run out: the RESOURCE_EXHAUSTED status, a 429, the weekly or
 * five-hour limit. Not every "exceeded": a deadline or a context window is no limit of your plan's.
 */
export const AGY_LIMIT = /resource.?exhausted|\b429\b|quota|rate.?limit|(weekly|five.?hour|usage) limit/i;

/** Signed out, as an ACP error says it: by its code, else its words. */
export const signedOut = (err: unknown): boolean => (err instanceof CodexRpcError && err.code === ACP_AUTH_REQUIRED) || AGY_SIGNED_OUT.test(err instanceof Error ? err.message : String(err));

/** The session's options a picker reads: its models, and the thinking levels the current one takes. */
export function modelRows(options: readonly ConfigOption[] | undefined): RuntimeStatus['models'] {
  const model = options?.find((o) => o.id === 'model' || o.category === 'model');
  const levels = options?.find((o) => o.id === 'thought_level' || o.category === 'thought_level')?.options.map((o) => o.value) ?? [];
  return (model?.options ?? []).map((o) => ({ value: o.value, label: o.name, description: o.description ?? '', ...(o.value === model?.currentValue && levels.length ? { efforts: levels } : {}) }));
}

interface StatusDeps {
  readonly bin?: string;
  readonly connect?: AgyConnect;
  /** Drops the session it opened to look (tests: a fake; none with a scripted `connect`). */
  readonly drop?: (sessionId: string) => Promise<unknown>;
}

const CACHE_MS = 60_000;
let cached: { readonly at: number; readonly status: Promise<RuntimeStatus> } | undefined;

/**
 * Antigravity on this Mac: not installed, not signed in, or ready with the models your plan has.
 * It opens a session to find out (no message is sent, so nothing of your quota is used), then
 * drops it. Kept a minute. Never signs in.
 */
export async function agyStatus(deps: StatusDeps & { readonly now?: number } = {}): Promise<RuntimeStatus> {
  const now = deps.now ?? Date.now();
  if (!deps.connect && cached && now - cached.at < CACHE_MS) return cached.status;
  const status = check(deps);
  if (!deps.connect) cached = { at: now, status };
  return status;
}

async function check(deps: StatusDeps): Promise<RuntimeStatus> {
  const bin = deps.bin ?? (deps.connect ? undefined : findAgy());
  if (!bin && !deps.connect) return { state: 'missing', fix: AGY_MISSING, models: [] };
  const cwd = os.tmpdir();
  const conn = await (deps.connect ?? spawnAgy)({ cwd, look: true, ...(bin ? { bin } : {}) }).catch(() => undefined);
  if (!conn) return { state: 'missing', fix: AGY_MISSING, models: [] };
  /** The session it opened to look: dropped once Antigravity has stopped, or it would write it back as it exits. */
  let opened: string | undefined;
  const drop = deps.drop ?? (deps.connect ? undefined : dropAgySession);
  try {
    const s = await conn.rpc.request<SessionResponse>('session/new', { cwd, mcpServers: [] }, 60_000);
    opened = s.sessionId;
    return { state: 'ready', models: modelRows(s.configOptions) };
  } catch (err) {
    if (signedOut(err)) return { state: 'signed_out', fix: AGY_SIGN_IN, models: [] };
    // Anything else (no network, a timeout): it's there and signed in as far as Beluga can tell; a run says what's wrong.
    return { state: 'ready', models: [] };
  } finally {
    await conn.proc.kill();
    if (opened && drop) void drop(opened).catch(() => false);
  }
}
