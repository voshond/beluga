import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type WebSocket from 'ws';

interface SocketEvents {
  open: [];
  message: [string];
  /** Fires once. 1006 means the connection dropped without a close frame. */
  close: [number];
  error: [Error];
  pong: [];
  /** The other side pinged (stream sockets only; answered with a pong by itself). */
  ping: [];
}

/**
 * The few things the hub and the client need from a connection, whether it's a
 * websocket (through a tunnel) or a direct Noise stream (peer to peer).
 */
export interface MessageSocket extends EventEmitter<SocketEvents> {
  readonly isOpen: boolean;
  send(data: string): void;
  /** Tell the other side why (the code survives on both transports), then end. */
  close(code?: number, reason?: string): void;
  /** Drop at once, without a close frame. */
  terminate(): void;
  ping(): void;
}

export const ABNORMAL_CLOSE = 1006;
const TOO_BIG_CLOSE = 1009;

/** A `ws` socket (either side) as a MessageSocket. */
class WsSocket extends EventEmitter<SocketEvents> implements MessageSocket {
  constructor(private readonly ws: WebSocket) {
    super();
    ws.on('open', () => this.emit('open'));
    ws.on('message', (data) => this.emit('message', data.toString()));
    ws.on('pong', () => this.emit('pong'));
    ws.on('close', (code) => this.emit('close', code));
    ws.on('error', (err) => this.emit('error', err));
  }

  get isOpen(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }

  send(data: string): void {
    if (this.isOpen) this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  terminate(): void {
    this.ws.terminate();
  }

  ping(): void {
    if (this.isOpen) this.ws.ping();
  }
}

export const fromWebSocket = (ws: WebSocket): MessageSocket => new WsSocket(ws);

/**
 * Frame kinds on a byte stream. Each frame is [u32 length][u8 kind][payload]; length counts kind + payload.
 * `deflated` is a text frame compressed (raw deflate), sent only to a side that said `inflates` (BLG-792):
 * a side that doesn't know these two kinds drops them unread, so it never hears a compressed one.
 */
const KIND = { text: 0, close: 1, ping: 2, pong: 3, deflated: 4, inflates: 5 } as const;
/** Text this long or longer goes compressed, when the other side inflates. */
export const DEFLATE_FROM = 1024;
type Kind = (typeof KIND)[keyof typeof KIND];
const HEADER = 5;
/** How long to wait for the other side to finish closing before cutting the stream. */
const CLOSE_GRACE_MS = 2_000;

function frame(kind: Kind, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(HEADER);
  head.writeUInt32BE(payload.length + 1, 0);
  head.writeUInt8(kind, 4);
  return Buffer.concat([head, payload]);
}

/**
 * Websocket-like messages over any duplex byte stream (here: hyperdht's Noise stream).
 * Close codes travel in a close frame, so 4010 "removed" means the same thing on both transports.
 */
class StreamSocket extends EventEmitter<SocketEvents> implements MessageSocket {
  private open: boolean;
  private closing = false;
  private closed = false;
  private code = ABNORMAL_CLOSE;
  private pending: Buffer = Buffer.alloc(0);
  private grace?: NodeJS.Timeout;
  /** The other side said it inflates: big text goes compressed. */
  private peerInflates = false;

  constructor(
    private readonly stream: Duplex,
    private readonly maxBytes: number,
    alreadyOpen: boolean,
    private readonly compress = false,
  ) {
    super();
    this.open = alreadyOpen;
    if (alreadyOpen && compress) this.write(KIND.inflates);
    stream.on('data', (chunk: Buffer) => this.onData(chunk));
    stream.on('open', () => this.onOpen());
    stream.on('connect', () => this.onOpen());
    // The other side ended: finish our half too so the stream can close.
    stream.on('end', () => stream.end());
    stream.on('close', () => this.finish());
    stream.on('error', (err: Error) => {
      if (!this.closing) this.emit('error', err);
    });
  }

  get isOpen(): boolean {
    return this.open && !this.closing && !this.closed;
  }

  send(data: string): void {
    const bytes = Buffer.from(data, 'utf8');
    if (this.peerInflates && bytes.length >= DEFLATE_FROM) {
      const packed = deflateRawSync(bytes, { level: 3 });
      if (packed.length < bytes.length) return this.write(KIND.deflated, packed);
    }
    this.write(KIND.text, bytes);
  }

  close(code = 1000, reason = ''): void {
    if (this.closing || this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.write(KIND.close, payload);
    this.closing = true;
    this.code = code;
    this.stream.end();
    this.grace = setTimeout(() => this.stream.destroy(), CLOSE_GRACE_MS);
    this.grace.unref();
  }

  terminate(): void {
    this.closing = true;
    this.stream.destroy();
  }

  ping(): void {
    this.write(KIND.ping);
  }

  private write(kind: Kind, payload?: Buffer): void {
    if (this.isOpen && !this.stream.destroyed) this.stream.write(frame(kind, payload));
  }

  private onOpen(): void {
    if (this.open || this.closing || this.closed) return;
    this.open = true;
    if (this.compress) this.write(KIND.inflates);
    this.emit('open');
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    clearTimeout(this.grace);
    this.emit('close', this.code);
  }

  private onData(raw: Buffer | Uint8Array): void {
    if (this.closed) return;
    // A stream over a WebSocket may hand plain Uint8Arrays (the companion relay).
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= HEADER && !this.closed) {
      const length = this.pending.readUInt32BE(0);
      // Refuse oversized frames from the header alone, before buffering them.
      if (length < 1 || length - 1 > this.maxBytes) {
        this.pending = Buffer.alloc(0);
        this.close(TOO_BIG_CLOSE, 'too large');
        return;
      }
      if (this.pending.length < 4 + length) return;
      const kind = this.pending.readUInt8(4);
      const payload = this.pending.subarray(HEADER, 4 + length);
      this.pending = this.pending.subarray(4 + length);
      if (!this.closing || kind === KIND.close) this.onFrame(kind, payload);
    }
  }

  private onFrame(kind: number, payload: Buffer): void {
    if (kind === KIND.text) this.emit('message', payload.toString('utf8'));
    else if (kind === KIND.deflated && this.compress) {
      let text: string;
      try {
        // Never more than a plain frame may be: a small frame can't unpack into a huge one.
        text = inflateRawSync(payload, { maxOutputLength: this.maxBytes }).toString('utf8');
      } catch {
        this.close(TOO_BIG_CLOSE, 'bad frame');
        return;
      }
      this.emit('message', text);
    } else if (kind === KIND.inflates && this.compress) this.peerInflates = true;
    else if (kind === KIND.ping) {
      this.write(KIND.pong);
      this.emit('ping');
    }
    else if (kind === KIND.pong) this.emit('pong');
    else if (kind === KIND.close) {
      if (!this.closing) this.code = payload.length >= 2 ? payload.readUInt16BE(0) : ABNORMAL_CLOSE;
      this.closing = true;
      this.stream.end();
    }
  }
}

export interface StreamSocketOptions {
  /** Largest message accepted; bigger ones close the connection (1009) before being buffered. */
  readonly maxBytes: number;
  /** True when the stream is already connected (server side); otherwise waits for its 'open' or 'connect' event. */
  readonly open?: boolean;
  /** Say this side inflates, and compress big text once the other side says it does too (a link to a computer, BLG-792). */
  readonly compress?: boolean;
}

export const fromStream = (stream: Duplex, opts: StreamSocketOptions): MessageSocket => new StreamSocket(stream, opts.maxBytes, opts.open ?? false, opts.compress ?? false);
