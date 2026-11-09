/** Limits on .env files sent to a computer (BLG-800): one file, and how many at once. Browser-safe. */
export const MAX_ENV_SEND_BYTES = 256 * 1024;
export const MAX_ENV_SEND_FILES = 32;

/** An ask in your app: these env files, by name, for a worktree on that computer. */
export interface EnvSendAsk {
  readonly id: string;
  readonly machineId: string;
  readonly machineName: string;
  /** The worktrees on the computer waiting (one ask per computer and project). */
  readonly workspaceIds: readonly string[];
  /** This Mac's project the files come from. */
  readonly projectId: string;
  readonly projectName: string;
  readonly files: readonly string[];
  readonly at: number;
}

export type EnvSendChoice = 'once' | 'always' | 'never';

/** A project whose env files go to your computers without asking (Settings takes it back). */
export interface EnvSendAlways {
  readonly root: string;
  readonly name: string;
  readonly at: number;
}

