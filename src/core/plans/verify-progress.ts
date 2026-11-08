/**
 * How far a plan's verification has got, from its agent's own run (BLG-772): so nobody takes a
 * check that takes a while for one that's stuck. The verifier goes through four checks in order and
 * starts each with a line naming it ("Duplicates: comparing the phone tasks…", see reviewPrompt);
 * those lines, its steps and whether it's thinking say where it is. Browser-safe: the Mac and the
 * phone's view read it.
 */

export const VERIFY_CHECKS = [
  { key: 'contradictions', label: 'Contradictions', match: /^contradictions?\b/i },
  { key: 'duplicates', label: 'Duplicates', match: /^duplicates?\b/i },
  { key: 'stale', label: 'Stale decisions', match: /^stale\b/i },
  { key: 'order', label: 'Order', match: /^order\b/i },
] as const;

export type VerifyCheckKey = (typeof VERIFY_CHECKS)[number]['key'];

export interface VerifyProgress {
  /** Each check, in order: done, the one it's on, or still to come. */
  readonly checks: ReadonlyArray<{ readonly key: VerifyCheckKey; readonly label: string; readonly state: 'done' | 'now' | 'todo' }>;
  /** What it's doing right now, in a line: its latest words, or what its step or silence means. */
  readonly now: string;
  /** Its latest words are its own (not Beluga's words for a step). */
  readonly said: boolean;
  /** When its run started (for how long it's been at it). */
  readonly startedAt?: number;
  /** Recording what it found: every check is behind it. */
  readonly recording: boolean;
}

/** The fields of the verifier's run it's read from (the store's agent log item). */
export interface VerifyRun {
  readonly text: string;
  readonly steps: readonly string[];
  readonly ts: number;
  readonly status: string;
  readonly between?: 'thinking' | 'writing';
  /** What it said before a later step (a check's line, then a tool): the store keeps those apart from its text. */
  readonly remarks?: ReadonlyArray<{ readonly text: string }>;
}

const plain = (line: string): string => line.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();

/** Where the verification stands (no run yet: it's starting). */
export function verifyProgress(run: VerifyRun | undefined): VerifyProgress {
  const paragraphs = [...(run?.remarks ?? []).map((r) => r.text), run?.text ?? '']
    .join('\n')
    .split(/\n+/)
    .map(plain)
    .filter(Boolean);
  // The furthest check its lines have reached.
  let reached = -1;
  for (const p of paragraphs) {
    const at = VERIFY_CHECKS.findIndex((c) => c.match.test(p));
    if (at > reached) reached = at;
  }
  const recording = Boolean(run?.steps.some((s) => /plan_review/.test(s)));
  const checks = VERIFY_CHECKS.map((c, i) => ({ key: c.key, label: c.label, state: recording || i < reached ? ('done' as const) : i === reached ? ('now' as const) : ('todo' as const) }));
  const last = paragraphs.at(-1);
  const read = Boolean(run?.steps.some((s) => /plan_get/.test(s)));
  const now = recording ? 'Writing down what it found' : last ? last : read ? (run?.between === 'thinking' ? 'Thinking it over' : 'Reading the whole plan') : run && run.status !== 'queued' ? 'Reading the plan' : 'Starting';
  return { checks, now: now.length > 220 ? `${now.slice(0, 220).trimEnd()}…` : now, said: Boolean(last) && !recording, ...(run ? { startedAt: run.ts } : {}), recording };
}
