/**
 * A model provider failing under OpenCode (BLG-686). Over ACP it says nothing of it: it retries,
 * and the turn waits, for as long as the provider keeps failing. Its log does say (`--print-logs`,
 * a `stream error` line per attempt), so the runner reads it: a limit or a sign-in that won't come
 * back by retrying ends the turn with that failure; anything else is said while it retries.
 */

export interface ProviderError {
  /** usage_limit and signed_out end the turn; retrying is said, and ended only once it keeps coming back. */
  readonly kind: 'usage_limit' | 'signed_out' | 'retrying';
  /** What the provider said ("Free usage limit reached…"). */
  readonly text: string;
}

/** A plan or credit that's used up: retrying won't help. */
const USED_UP = /usage limit|quota|insufficient[_ ]?(balance|credits?|funds)|credit balance|billing|exceeded your current/i;
/** Too many requests: retrying may help, for a while. */
const RATE = /rate.?limit|too many requests|\b429\b/i;
/** The provider won't take its key or login. */
const AUTH = /api.?key|unauthori[sz]ed|\b401\b|\b403\b|forbidden|authenticat|not logged in|invalid.{0,20}(token|key)|ProviderAuthError/i;

/** A `stream error` line of OpenCode's log as a provider error; undefined for any other line, and for its small side agents' (a title). */
export function providerErrorOf(line: string): ProviderError | undefined {
  if (!line.includes('message="stream error"') || /\bsmall=true\b/.test(line)) return undefined;
  const raw = /error\.error="((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
  if (!raw) return undefined;
  const text = raw
    .replace(/\\"/g, '"')
    .replace(/^AI_RetryError: Failed after \d+ attempts?\. Last error: /, '')
    .replace(/^AI_\w+Error: /, '')
    .trim();
  if (USED_UP.test(text)) return { kind: 'usage_limit', text };
  if (AUTH.test(text)) return { kind: 'signed_out', text };
  return { kind: 'retrying', text };
}

/** How many times the same retried error may come back before the turn ends with it. */
export const RETRIES_BEFORE_FAILING = 4;

/** Whether a retried error ends as a usage limit once it keeps coming back (too many requests), or as a failure. */
export const isRateLimit = (text: string): boolean => RATE.test(text);
