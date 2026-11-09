import { randomUUID } from 'node:crypto';

/**
 * Work moving between your computers (BLG-806, BLG-807) goes over your app's links as one JSON
 * package, in pieces: a frame holds 8 MB. The computer it leaves keeps it until your app has
 * fetched every piece; the one it goes to gathers the pieces until it's landed. Both let go of a
 * package left behind after a while.
 */

/** A package goes over the link in pieces this big. */
export const MOVE_CHUNK = 2 * 1024 * 1024;
/** And at most this big in all. */
export const MAX_MOVE = 160 * 1024 * 1024;
const KEEP_MS = 15 * 60_000;

export class MoveTransfers {
  private readonly out = new Map<string, { readonly text: string; readonly at: number }>();
  private readonly incoming = new Map<string, { readonly parts: string[]; readonly total: number; readonly at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A package kept to be fetched → its token and how many pieces. */
  send(pkg: unknown, what = 'This'): { readonly token: string; readonly chunks: number } {
    this.forget();
    const text = JSON.stringify(pkg);
    if (text.length > MAX_MOVE) throw new Error(`${what} is too big to move over the link`);
    const token = randomUUID();
    this.out.set(token, { text, at: this.now() });
    return { token, chunks: Math.max(1, Math.ceil(text.length / MOVE_CHUNK)) };
  }

  /** One piece going out (the last one lets it go). */
  chunk(token: string, n: number): string {
    const p = this.out.get(token);
    if (!p) throw new Error('That move isn’t ready here any more: move it again');
    if (n === Math.max(1, Math.ceil(p.text.length / MOVE_CHUNK)) - 1) this.out.delete(token);
    return p.text.slice(n * MOVE_CHUNK, (n + 1) * MOVE_CHUNK);
  }

  /** One piece coming in. */
  receive(token: string, n: number, total: number, data: string): void {
    this.forget();
    const p = this.incoming.get(token) ?? { parts: [], total, at: this.now() };
    if (p.total !== total || n >= total) throw new Error('That piece doesn’t belong to this move');
    p.parts[n] = data;
    this.incoming.set(token, p);
  }

  /** Every piece is in → the package as it came (parsed; the caller checks it). */
  take(token: string): unknown {
    const p = this.incoming.get(token);
    this.incoming.delete(token);
    if (!p || p.parts.filter((x) => x !== undefined).length !== p.total) throw new Error('Not all of it came over: move it again');
    try {
      return JSON.parse(p.parts.join(''));
    } catch {
      throw new Error('It didn’t come over whole: move it again');
    }
  }

  private forget(): void {
    const old = this.now() - KEEP_MS;
    for (const [k, v] of this.out) if (v.at < old) this.out.delete(k);
    for (const [k, v] of this.incoming) if (v.at < old) this.incoming.delete(k);
  }
}
