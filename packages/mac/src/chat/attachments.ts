// Relative, not @beluga: the root's tests and typecheck read this file too.
import type { PathInfo } from '../../../../src/core/attachments.js';
import type { DropVerdict, SentPiece } from '../../../../src/machines/uploads.js';

export type { DropVerdict } from '../../../../src/machines/uploads.js';

/**
 * Files from this Mac on a chat that runs on one of your computers (BLG-793): each goes there a
 * piece at a time (machines.upload.send: this Mac's daemon reads a piece and puts it there over the
 * link), one file after another, with how far it got; then it waits in the box by its path there,
 * as a file on this Mac would by its own. No DOM here (tests/machines-uploads.test.ts).
 */

export interface Sending {
  readonly name: string;
  readonly sent: number;
  readonly total: number;
}

/** One piece of `file` at `off` to `machine` as upload `n` (this Mac's daemon, machines.upload.send). */
export type SendPiece = (machine: string, n: number, file: string, off: number) => Promise<SentPiece>;

let nextUpload = Math.floor(Date.now() % 1_000_000_000);

/** Send `files` there → the ones that arrived, as files there (a picture stays one). */
export async function sendFiles(
  send: SendPiece,
  machine: string,
  files: readonly PathInfo[],
  onProgress: (now: Sending | undefined) => void,
  onError: (file: PathInfo, err: unknown) => void,
): Promise<PathInfo[]> {
  const there: PathInfo[] = [];
  for (const f of files) {
    const n = nextUpload++;
    let off = 0;
    onProgress({ name: f.name, sent: 0, total: f.size });
    try {
      for (;;) {
        const r = await send(machine, n, f.path, off);
        onProgress({ name: f.name, sent: r.sent, total: r.total });
        if (r.path) {
          there.push({ path: r.path, name: f.name, kind: 'file', size: r.total, image: r.image ?? f.image });
          break;
        }
        // A piece that moved nothing would loop forever.
        if (r.sent <= off) throw new Error('The upload stopped moving; send it again');
        off = r.sent;
      }
    } catch (err) {
      onError(f, err);
    }
  }
  onProgress(undefined);
  return there;
}

/** "45%" of a file on its way (a file with nothing in it is all there at once). */
export const sentShare = (s: Sending): string => `${s.total ? Math.min(100, Math.floor((s.sent / s.total) * 100)) : 100}%`;

/** Dropped files split by what this Mac says of each (machines.upload.check, BLG-854). */
export interface DropPlan {
  readonly send: readonly PathInfo[];
  /** Env files: they go only after Send Once. */
  readonly ask: readonly PathInfo[];
  readonly refused: readonly { readonly name: string; readonly reason: string }[];
}

export function planDrop(files: readonly PathInfo[], checks: readonly DropVerdict[]): DropPlan {
  const by = new Map(checks.map((c) => [c.path, c]));
  const send: PathInfo[] = [];
  const ask: PathInfo[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const f of files) {
    const c = by.get(f.path);
    // Not checked: not sent.
    if (!c) refused.push({ name: f.name, reason: 'it couldn’t be checked' });
    else if (c.verdict === 'refuse') refused.push({ name: f.name, reason: c.reason });
    else (c.verdict === 'ask' ? ask : send).push(f);
  }
  return { send, ask, refused };
}

/** The env send's ask for dropped env files: their names only, Send Once or Don't Send. */
export function envAsk(files: readonly PathInfo[], machineName: string, run: () => void): { kind: 'confirm'; title: string; message: string; confirm: string; cancel: string; run: () => void } {
  const names = files.map((f) => f.name).join(', ');
  return {
    kind: 'confirm',
    title: `Send ${names} to ${machineName}?`,
    message: `${files.length === 1 ? 'It holds' : 'They hold'} secrets. ${files.length === 1 ? 'It goes' : 'They go'} over your encrypted link, for this message only.`,
    confirm: 'Send Once',
    cancel: 'Don’t Send',
    run,
  };
}
