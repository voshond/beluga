import { execFile } from 'node:child_process';
import { codexCommand } from '../codex/app-server.js';

/**
 * Beluga's settings for one OpenCode run, given in OPENCODE_CONFIG_CONTENT (BLG-686). OpenCode
 * merges that after your own config (global and the project's), value by value, so it decides:
 * - every permission, top-level and every agent's, is "ask" (a "deny" of yours stays a deny), so
 *   each tool call comes to Beluga as `session/request_permission` and is judged there like
 *   Claude's (agent/tool-gate.ts). OpenCode's own default for its build agent is "allow" for
 *   everything, and an agent's own permissions win over the top-level ones, so each agent is named;
 * - its `question` tool is off: over ACP it can't reach you (it asks in its answer instead);
 * - after a step you decline it carries on and answers (Claude does), instead of ending the turn;
 * - Beluga's instructions for the run (rooms, tools, the task's brief) are one more instructions file.
 */

/** The permission keys OpenCode 1.19 knows, each set even when your config doesn't name it. */
export const PERMISSION_KEYS = ['read', 'edit', 'glob', 'grep', 'list', 'bash', 'task', 'skill', 'lsp', 'todoread', 'todowrite', 'webfetch', 'websearch', 'codesearch', 'external_directory', 'doom_loop'] as const;

/** OpenCode's own agents (its primary build and plan, the general and explore sub-agents). */
export const BUILT_IN_AGENTS = ['build', 'plan', 'general', 'explore'] as const;

type Action = 'allow' | 'ask' | 'deny';
type PermissionValue = Action | Record<string, Action>;
export type Permission = Action | Record<string, PermissionValue>;

/** The parts of OpenCode's resolved config (`opencode debug config`) Beluga reads. */
export interface ResolvedConfig {
  readonly permission?: Permission;
  readonly agent?: Readonly<Record<string, { readonly permission?: Permission } | undefined>>;
  readonly mode?: Readonly<Record<string, { readonly permission?: Permission } | undefined>>;
  readonly mcp?: Readonly<Record<string, unknown>>;
  readonly model?: string;
}

/** An action as Beluga runs it: anything that would run without asking asks; a deny stays one. */
const asked = (a: unknown): Action => (a === 'deny' ? 'deny' : 'ask');

/** A pattern map ({ "git *": "allow", "*": "ask" }) with each of its actions asked. */
const askedPatterns = (v: unknown): PermissionValue => (v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, a]) => [k, asked(a)])) : asked(v));

/**
 * A permission block where nothing runs without asking: every key yours names (each pattern too),
 * then `*` and every key OpenCode knows. Merged into yours key by key, so none of yours is left
 * as it was. `extra`: Beluga's own rules on top (the question tool off; a plan's edits denied).
 */
export function askEverything(yours: Permission | undefined, extra: Readonly<Record<string, Action>> = {}): Record<string, PermissionValue> {
  const own = yours && typeof yours === 'object' ? Object.fromEntries(Object.entries(yours).map(([k, v]) => [k, askedPatterns(v)])) : {};
  const all: Record<string, PermissionValue> = { ...own, '*': yours === 'deny' ? 'deny' : 'ask' };
  for (const key of PERMISSION_KEYS) if (!(key in own)) all[key] = 'ask';
  return { ...all, question: 'deny', ...extra };
}

export interface RunConfigOptions {
  /** A file with Beluga's instructions for the run. */
  readonly instructions?: string;
  /** Plan first: the plan agent edits nothing (as OpenCode's own plan agent doesn't). */
  readonly planning?: boolean;
}

/** OPENCODE_CONFIG_CONTENT for a run: your config made to ask about everything, and Beluga's instructions. */
export function runConfig(resolved: ResolvedConfig | undefined, opts: RunConfigOptions = {}): Record<string, unknown> {
  const names = new Set<string>([...BUILT_IN_AGENTS, ...Object.keys(resolved?.agent ?? {}), ...Object.keys(resolved?.mode ?? {})]);
  const agent = Object.fromEntries([...names].map((name) => [name, { permission: askEverything(resolved?.agent?.[name]?.permission ?? resolved?.mode?.[name]?.permission, name === 'plan' ? { edit: 'deny' } : {}) }]));
  return {
    permission: askEverything(resolved?.permission),
    agent,
    experimental: { continue_loop_on_deny: true },
    ...(opts.instructions ? { instructions: [opts.instructions] } : {}),
  };
}

/** The agent a side call runs as: Beluga's instructions as its whole prompt, only the tools it was given (each still asked). */
export const SIDE_AGENT = 'beluga-side';

/**
 * OPENCODE_CONFIG_CONTENT for a side call (complete.ts): one agent of Beluga's, `system` its whole
 * prompt, every tool asking (Beluga allows only the ones the call was given, and turns the rest
 * down). Not denied here: with every tool denied in its config, OpenCode 1.19 never answers.
 */
export function sideConfig(system: string): Record<string, unknown> {
  return {
    agent: { [SIDE_AGENT]: { mode: 'primary', prompt: system, permission: askEverything(undefined), description: 'Beluga’s one-shot answers' } },
    experimental: { continue_loop_on_deny: true },
  };
}

const RESOLVE_TIMEOUT_MS = 15_000;
const CACHE_MS = 30_000;
const cache = new Map<string, { readonly at: number; readonly config: Promise<ResolvedConfig | undefined> }>();

/**
 * Your OpenCode config as OpenCode resolves it for a folder (`opencode debug config`: global, the
 * project's, its agents), so every permission and agent in it can be made to ask. Kept for a short
 * while per folder (a follow-up run starts at once). Undefined when OpenCode couldn't say: then
 * only the keys and agents OpenCode always has are set.
 */
export function resolveConfig(bin: string, cwd: string, env: Readonly<Record<string, string | undefined>> = process.env, now = Date.now()): Promise<ResolvedConfig | undefined> {
  const hit = cache.get(cwd);
  if (hit && now - hit.at < CACHE_MS) return hit.config;
  const how = codexCommand(bin, ['debug', 'config']);
  const config = new Promise<ResolvedConfig | undefined>((resolve) => {
    execFile(how.command, [...how.args], { cwd, env: { ...env }, timeout: RESOLVE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, shell: how.shell, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        const start = stdout.indexOf('{');
        resolve(start === -1 ? undefined : (JSON.parse(stdout.slice(start)) as ResolvedConfig));
      } catch {
        resolve(undefined);
      }
    });
  });
  cache.set(cwd, { at: now, config });
  return config;
}

/** Forget what was resolved (tests). */
export const forgetResolved = (): void => cache.clear();
