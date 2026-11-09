/**
 * A computer's dev server forwarded to this Mac (BLG-802): its port there, and where it listens
 * here (the same one when it was free). Browser-safe.
 */
export interface PortForward {
  readonly machineId: string;
  readonly machineName: string;
  readonly workspaceId: string;
  /** Its port on the computer. */
  readonly port: number;
  /** Where it opens on this Mac: localhost:<local>. */
  readonly local: number;
  /** What it is: vite, next, node… */
  readonly name: string;
}

/** A port of this Mac shared with a worktree on one of your computers (BLG-804): reachable there at localhost:<port>. */
export interface PortShare {
  readonly machineId: string;
  readonly workspaceId: string;
  readonly port: number;
}
