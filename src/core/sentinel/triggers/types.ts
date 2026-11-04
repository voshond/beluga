import type { GitHubRepo, GhRunner } from '../../../workspaces/github.js';
import type { Store } from '../../store.js';
import type { Sentinel } from '../model.js';

/**
 * Event triggers (docs/sentinel.md §1, phase 3): what each kind needs, what it tells its sentinel,
 * and the polling loop the polled kinds share (GitHub, Stripe, uptime, Sentry). Each kind is one
 * file with a `start(trigger, ctx, deps)` that returns its stop; what it saw last is its cursor,
 * which the sentinel's file keeps, so a restart neither fires twice nor misses what came meanwhile.
 */

/** Something happened: in words for the run's "by what" line, and as data for Claude and scripts. */
export interface TriggerEvent {
  readonly summary: string;
  readonly payload?: unknown;
  /**
   * A sentinel's own run made it (its worktree, pull request or chat): never starts that sentinel
   * again (the loop guard), nor one that led to that run.
   */
  readonly from?: { readonly sentinelId: string; readonly runId: string };
}

export interface TriggerContext<C = unknown> {
  /** The sentinel as it was when its trigger started (a change restarts it). */
  readonly sentinel: Sentinel;
  /** What it saw last (none: the first look, which fires nothing and only notes where things are). */
  cursor(): C | undefined;
  save(cursor: C): void;
  fire(event: TriggerEvent): void;
  /** Why it can't watch, in words with what to do; undefined once it can again. */
  trouble(words: string | undefined): void;
}

/** What a JSON answer needs of fetch (tests and the demo pass their own). */
export type FetchLike = (url: string, init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly signal?: AbortSignal; readonly redirect?: 'follow' | 'manual' }) => Promise<{ readonly status: number; readonly ok?: boolean; readonly body?: { cancel(): Promise<void> } | null; text(): Promise<string> }>;

/** What the event triggers use, injected (the daemon's real ones; fakes in the tests and the demo). */
export interface TriggerDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly now?: () => number;
  /** The GitHub CLI (`runGhCli`). */
  readonly gh?: GhRunner;
  /** A project's GitHub repository (none: not on GitHub). */
  readonly repoOf?: (projectId: string) => Promise<GitHubRepo | undefined>;
  readonly fetch?: FetchLike;
  /** A project's Stripe key from Earnings (~/.beluga/stripe.json), or none. */
  readonly stripeKey?: (projectId: string) => string | undefined;
  /** Your variables (Settings › Environment) for a project, or yours with none. */
  readonly env?: (projectId: string | undefined) => Record<string, string>;
  /** Makes the webhook server public: a Cloudflare quick tunnel (none: the webhook kind has no address). */
  readonly tunnel?: WebhookTunnel;
  /** Beluga events are only listened to after this long from start (the start's own state settling isn't news). */
  readonly warmupMs?: number;
  readonly log?: (line: string) => void;
}

/** Opens a public address for a local port; `onDied` when it stops answering. */
export type WebhookTunnel = (port: number, onDied: (why: string) => void) => Promise<{ readonly url: string; close(): void }>;

// ------------------------------------------------------------------ polling

export const MINUTE = 60_000;
/** Errors in a row double the wait, up to this. */
export const MAX_BACKOFF_MS = 30 * MINUTE;
/** A poller with trouble (no gh, no key, no token) looks again this much later. */
export const TROUBLE_MS = 10 * MINUTE;
/** Errors in a row before the page says so (fewer are a blip). */
const ERRORS_SHOWN = 3;

/**
 * What one look says: nothing (it looked; the cursor moved and events fired), or trouble in
 * words (it couldn't look: the page says so, and it sleeps TROUBLE_MS). An error thrown is a blip:
 * it waits twice as long each time (up to 30 minutes), back to normal on the next good look.
 */
export type Look = () => Promise<string | undefined>;

export interface PollOptions {
  readonly everyMs: number;
  /** The first look (0: at once). */
  readonly firstMs?: number;
  /** What a failing look's errors are called on the page after a few in a row ("GitHub didn't answer"). */
  readonly failing?: string;
}

/** Look now and then until stopped: every `everyMs`, slower after errors, 10 minutes with trouble. → stop. */
export function startPolling(ctx: Pick<TriggerContext, 'trouble'>, look: Look, opts: PollOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let errors = 0;
  const next = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void once(), ms);
    timer.unref?.();
  };
  const once = async (): Promise<void> => {
    if (stopped) return;
    let trouble: string | undefined;
    try {
      trouble = await look();
    } catch (err) {
      if (stopped) return;
      errors++;
      const wait = Math.min(MAX_BACKOFF_MS, opts.everyMs * 2 ** errors);
      if (errors >= ERRORS_SHOWN) ctx.trouble(`${opts.failing ?? 'It couldn’t look'}: ${firstWords(err)}. It tries again in ${minutesText(wait)}.`);
      return next(wait);
    }
    if (stopped) return;
    errors = 0;
    ctx.trouble(trouble);
    next(trouble ? TROUBLE_MS : opts.everyMs);
  };
  next(opts.firstMs ?? 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export const minutesText = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / MINUTE));
  return m === 1 ? 'a minute' : `${m} minutes`;
};

/** An error's first line, short, never more than 160 characters. */
export function firstWords(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).split('\n').map((l) => l.trim()).find(Boolean) ?? 'something went wrong';
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Ids seen lately, newest last, at most `max` (so a long-running sentinel's file stays small). */
export const remember = (seen: readonly string[], add: readonly string[], max = 300): string[] => {
  const set = new Set(seen);
  const out = [...seen];
  for (const id of add) {
    if (set.has(id)) continue;
    set.add(id);
    out.push(id);
  }
  return out.slice(-max);
};

/** One line, cut (summaries). */
export const clip = (text: string, max = 120): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
export const time = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) || 0 : typeof v === 'number' ? v : 0);
