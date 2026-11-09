// Types for scripts/e2e-lock.mjs (used by packages/mac's playwright config, its e2e setup and the tests).

export interface E2eRun {
  readonly id: string;
  readonly pid: number;
  /** Whose run, in words: "KLD-12". */
  readonly name: string;
  readonly worktree?: string;
  readonly port?: number;
  readonly home?: string;
  readonly startedAt: number;
  groups?: number[];
}

export function stateDir(): string;
export function lockFile(): string;
export function worktreeOf(dir: string): string;
export function runName(worktree: string, branch?: string): string;
export function portFor(worktree: string): number;
export function homesFor(worktree: string): { readonly home: string; readonly claude: string };
/** One of a run's demo homes: worker `worker`'s slot 0 or 1 (in use, warming up), next to the run's home. */
export function slotHomes(homes: { readonly home: string; readonly claude: string }, worker: number, slot: 0 | 1): { readonly home: string; readonly claude: string };
/** How many playwright workers a run uses: E2E_WORKERS, else one per 2 idle cores, up to 3. `busy` is the CPU share in use (0–1). */
export function workerCount(env?: Record<string, string | undefined>, cores?: number, busy?: number): number;
/** The share of the CPU actually in use (0–1) over `ms`. */
export function busyShare(ms?: number): Promise<number>;
/** CPU seconds from ps's time column. */
export function cpuSeconds(time: string): number;
export function pidsUnder(root: number, table: ReadonlyArray<{ pid: number; ppid: number }>): Set<number>;
export interface Usage {
  cores: number;
  bytes: number;
  /** What was busiest at the CPU peak: "node 2.1". */
  busiest?: string[];
}
/** What a run costs the Mac (peak CPU in cores, peak memory in bytes), sampled now and then. */
export function usageMeter(): { readonly peak: Usage; sample(pids: Set<number>, table?: ReadonlyArray<{ pid: number; cpu: number; bytes: number; name?: string }>, now?: number): void };
export function usageLine(peak: Usage, wallMs: number, cores?: number): string;
export function alive(pid: number): boolean;
export function readLock(file?: string): E2eRun | undefined;
export function tryLock(run: E2eRun, opts?: { file?: string; onStale?: (old: E2eRun) => void }): { ok: true } | { ok: false; holder: E2eRun };
export function releaseLock(pid?: number, file?: string): void;
export function waitingLine(holder: E2eRun, now?: number): string;
export function waitForLock(
  run: E2eRun,
  opts?: { file?: string; onStale?: (old: E2eRun) => void; log?: (line: string) => void; pollMs?: number; sayEveryMs?: number; maxMs?: number },
): Promise<boolean>;
export function processTable(): Array<{ pid: number; ppid: number; pgid: number }>;
export function groupsUnder(root: number, table: ReadonlyArray<{ pid: number; ppid: number; pgid: number }>): Set<number>;
export function processesTagged(key: string, value: string): Array<{ pid: number; pgid: number }>;
export function listeners(port: number): number[];
/** Why the run's port can't be used, or undefined when it's free (checked before playwright starts). */
export function portProblem(port: number): string | undefined;
export function stopGroups(targets: { groups?: readonly number[]; pids?: readonly number[] }, opts?: { graceMs?: number }): Promise<void>;
export function processesOf(run: E2eRun, rows?: ReadonlyArray<{ pid: number; pgid: number; line: string }>): Array<{ pid: number; pgid: number }>;
export function stopRun(run: E2eRun, opts?: { graceMs?: number }): Promise<void>;
export function loadPerCore(): number;
export const OVERLOADED: number;
export function rerunArgs(args: readonly string[]): string[] | undefined;
