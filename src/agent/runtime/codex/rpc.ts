import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * JSON-RPC with `codex app-server`, one JSON message per line on its stdio (Codex leaves out the
 * "jsonrpc" field, and accepts it missing). Three kinds come in: answers to our requests,
 * notifications (a turn's items as they happen) and requests from the server (approvals), which
 * `onRequest` answers. An Agent Client Protocol agent (OpenCode's `opencode acp`) speaks the same
 * framing with the field set: `{ jsonrpc: true }`.
 */

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

type Notify = (method: string, params: Record<string, unknown>) => void;
/** Answers a server request: its result, or throws to answer with an error. */
type Answer = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** Who's on the other end (named in errors), and whether each message says `"jsonrpc": "2.0"`. */
export interface RpcOptions {
  readonly name?: string;
  readonly jsonrpc?: boolean;
}

interface Message {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export class CodexRpc {
  private next = 0;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<Notify>();
  private answer: Answer = async (method) => {
    throw new CodexRpcError(`${method} is not handled`, -32601);
  };
  private ended = false;
  private readonly name: string;
  /** Resolves once the server's end closed (it exited, or was killed). */
  readonly closed: Promise<void>;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly opts: RpcOptions = {},
  ) {
    this.name = opts.name ?? 'Codex';
    const lines = readline.createInterface({ input });
    lines.on('line', (line) => this.receive(line));
    this.closed = new Promise((resolve) =>
      lines.once('close', () => {
        this.ended = true;
        for (const p of this.pending.values()) p.reject(new CodexRpcError(`${this.name} stopped`));
        this.pending.clear();
        resolve();
      }),
    );
    // A server gone mid-write is told by `closed`, not an unhandled error.
    output.on('error', () => undefined);
  }

  get isClosed(): boolean {
    return this.ended;
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    if (this.ended) return Promise.reject(new CodexRpcError(`${this.name} stopped`));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => this.pending.delete(id) && reject(new CodexRpcError(`${method} timed out`)), timeoutMs) : undefined;
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  onNotification(fn: Notify): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  onRequest(fn: Answer): void {
    this.answer = fn;
  }

  private write(msg: object): void {
    if (!this.ended) this.output.write(`${JSON.stringify(this.opts.jsonrpc ? { jsonrpc: '2.0', ...msg } : msg)}\n`);
  }

  private receive(line: string): void {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return; // not ours (a stray log line)
    }
    if (msg.method && msg.id !== undefined) return void this.serve(msg.id, msg.method, msg.params ?? {});
    if (msg.method) {
      for (const fn of this.listeners) fn(msg.method, msg.params ?? {});
      return;
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new CodexRpcError(msg.error.message ?? `${this.name} error`, msg.error.code));
    else p.resolve(msg.result);
  }

  private async serve(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      this.write({ id, result: await this.answer(method, params) });
    } catch (err) {
      this.write({ id, error: { code: err instanceof CodexRpcError && err.code ? err.code : -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
