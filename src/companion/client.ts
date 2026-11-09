/// <reference path="./modules.d.ts" />
/// <reference path="../net/mesh/modules.d.ts" />
import b4a from 'b4a';
import type DHT from 'hyperdht';
import { DialError, type DialReport, type NoiseStream, type OpenRelay, dialMac } from './dial.js';
import { type DeviceKeys, type DeviceTicket, canonical, checkDevProof, devProof, deviceSecrets, fingerprint, hex, parseDeviceTicket, signKeyPair, verifyCert } from './device-crypto.js';
import {
  COMPANION_PIECE,
  COMPANION_PROTO,
  type DeviceCert,
  type DevicePair,
  KEEPALIVE_AWAY_MS,
  KEEPALIVE_MS,
  SINCE,
  type MacFrame,
  MAX_COMPANION_FRAME,
  MAX_UPLOAD_BYTES,
  type PhoneFrame,
  type Topic,
  TUN_PIECE,
  compatible,
  parseDevicePair,
  parseMacFrame,
} from './protocol.js';

/**
 * The phone's side of the link, runtime-agnostic: it runs in Holepunch's Bare worklet on the
 * phone (react-native-bare-kit) and in Node for tests. So no Node builtins: only hyperdht (its
 * node is passed in), sodium-universal and b4a, and the shared, pure protocol.ts and
 * device-crypto.ts. Frames are the transport's (src/net/transport.ts): [u32 length][u8 kind][payload].
 *
 * - `pairDevice`: use a pairing (QR or code), wait for you to click Pair on the Mac, get the
 *   device certificate and the Mac's companion address.
 * - `CompanionClient`: dial the Mac with the device's link key, hello → welcome (or 4002: update),
 *   subscribe to what's on screen, call the API, fetch files by ref, keep alive while open.
 *   It reconnects only when asked (the app decides: foreground, a push, a retry button).
 */

type Bytes = Uint8Array;

/** What the client needs of a hyperdht node (the phone makes one when the app comes to the front). */
export type DhtNode = Pick<DHT, 'connect'> & Partial<Pick<DHT, 'mutableGet'>>;

/** How to reach the Mac besides hyperdht (dial.ts): the relay, and what worked last time. */
export interface DialHints {
  /** Opens WebSockets (the app's native one, via the worklet's IPC; `ws` in Node). Without it, no relay. */
  readonly openRelay?: OpenRelay;
  /** Relay URLs already known, best first (the pairing link's, the last welcome's). */
  readonly relays?: readonly string[];
  /** The way that worked last time on this network. */
  readonly prefer?: 'p2p' | 'relay';
  readonly staggerMs?: number;
  readonly dialTimeoutMs?: number;
  readonly probeDht?: () => DialReport['dht'];
  /** Tests: never dial hyperdht. */
  readonly noP2p?: boolean;
}

const dialOpts = (h: DialHints) => ({
  ...(h.openRelay ? { openRelay: h.openRelay } : {}),
  ...(h.prefer ? { prefer: h.prefer } : {}),
  ...(h.staggerMs !== undefined ? { staggerMs: h.staggerMs } : {}),
  ...(h.dialTimeoutMs !== undefined ? { timeoutMs: h.dialTimeoutMs } : {}),
  ...(h.probeDht ? { probeDht: h.probeDht } : {}),
  ...(h.noP2p ? { noP2p: true } : {}),
});

export { DialError, type DialReport } from './dial.js';

// ---- a tiny emitter (Bare has no node:events)

type Listener = (...args: unknown[]) => void;
class Emitter<E extends Record<string, unknown[]>> {
  private readonly listeners = new Map<keyof E, Set<Listener>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(fn as unknown as Listener);
    this.listeners.set(event, set);
    return () => void set.delete(fn as unknown as Listener);
  }
  protected emit<K extends keyof E>(event: K, ...args: E[K]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...(args as unknown[]));
  }
}

// ---- frames on the Noise stream

const KIND = { text: 0, close: 1, ping: 2, pong: 3 } as const;

function frame(kind: number, payload: Bytes = b4a.alloc(0)): Bytes {
  const head = b4a.alloc(5);
  b4a.writeUInt32BE(head, payload.length + 1, 0);
  head[4] = kind;
  return b4a.concat([head, payload]);
}

interface FramedEvents extends Record<string, unknown[]> {
  open: [];
  text: [string];
  pong: [];
  close: [number, string];
}

/** Messages over the stream, as transport.ts frames them (close codes travel in a close frame). */
class Framed extends Emitter<FramedEvents> {
  private pending: Bytes = b4a.alloc(0);
  private code = 1006;
  private reason = '';
  private closing = false;
  private done = false;
  opened = false;

  constructor(
    readonly stream: NoiseStream,
    private readonly maxBytes: number,
    /** The stream's Noise handshake is already done (dialMac hands over open streams). */
    alreadyOpen = false,
  ) {
    super();
    this.opened = alreadyOpen;
    stream.on('open', () => this.onOpen());
    stream.on('connect', () => this.onOpen());
    stream.on('data', (d) => this.onData(d));
    stream.on('end', () => stream.end());
    stream.on('error', () => undefined);
    stream.on('close', () => this.finish());
  }

  get isOpen(): boolean {
    return this.opened && !this.closing && !this.done;
  }

  send(text: string): void {
    if (this.isOpen) this.stream.write(frame(KIND.text, b4a.from(text, 'utf8')));
  }

  ping(): void {
    if (this.isOpen) this.stream.write(frame(KIND.ping));
  }

  close(code = 1000, reason = ''): void {
    if (this.closing || this.done) return;
    const r = b4a.from(reason, 'utf8');
    const payload = b4a.alloc(2 + r.length);
    payload[0] = (code >> 8) & 0xff;
    payload[1] = code & 0xff;
    payload.set(r, 2);
    if (this.opened) this.stream.write(frame(KIND.close, payload));
    this.closing = true;
    this.code = code;
    this.reason = reason;
    this.stream.end();
    const t = setTimeout(() => this.stream.destroy(), 2_000);
    (t as { unref?: () => void }).unref?.();
  }

  terminate(): void {
    this.closing = true;
    this.stream.destroy();
  }

  private onOpen(): void {
    if (this.opened || this.done) return;
    this.opened = true;
    this.emit('open');
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.emit('close', this.code, this.reason);
  }

  private onData(chunk: Bytes): void {
    if (this.done) return;
    this.pending = this.pending.length ? b4a.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 5 && !this.done) {
      const length = b4a.readUInt32BE(this.pending, 0);
      if (length < 1 || length - 1 > this.maxBytes) {
        this.pending = b4a.alloc(0);
        this.close(1009, 'too large');
        return;
      }
      if (this.pending.length < 4 + length) return;
      const kind = this.pending[4]!;
      const payload = this.pending.subarray(5, 4 + length);
      this.pending = this.pending.subarray(4 + length);
      if (kind === KIND.text && !this.closing) this.emit('text', b4a.toString(payload, 'utf8'));
      else if (kind === KIND.ping) this.stream.write(frame(KIND.pong));
      else if (kind === KIND.pong) this.emit('pong');
      else if (kind === KIND.close) {
        if (!this.closing) {
          this.code = payload.length >= 2 ? (payload[0]! << 8) | payload[1]! : 1006;
          this.reason = payload.length > 2 ? b4a.toString(payload.subarray(2), 'utf8') : '';
        }
        this.closing = true;
        this.stream.end();
      }
    }
  }
}

const sameBytes = (a: Bytes | null | undefined, b: Bytes): boolean => Boolean(a) && a!.length === b.length && b4a.equals(a!, b);

// ---- pairing

/** The phone, as it introduces itself when pairing. */
export interface PhoneDevice {
  readonly keys: DeviceKeys;
  readonly name: string;
  readonly platform: 'android' | 'ios';
  /** The app's version ("1.0.0"). */
  readonly app: string;
}

export interface Paired {
  readonly cert: DeviceCert;
  /** The Mac's companion address (hex): where the phone dials from now on. */
  readonly address: string;
  readonly macName: string;
  /** The four pictures both screens showed. */
  readonly fingerprint: string;
  /** The Mac's relay (keep it: the next link tries it when the direct way fails). */
  readonly relay?: string;
  /** How the pairing reached the Mac. */
  readonly path: import('./protocol.js').LinkPath;
}

/** The Mac turned the pairing away; `why` says it for the explanation (diagnose.ts). */
export class PairRefused extends Error {
  constructor(
    message: string,
    readonly why?: import('./diagnose.js').PairRefusal,
  ) {
    super(message);
  }
}

const NOT_FOUND = 'Your Mac isn’t answering that pairing. Check the code, or start a new one on your Mac (they work for 10 minutes).';

/**
 * Pair with your Mac: find it by the pairing's secret (or code), prove we hold it, show the
 * fingerprint (`onWait`) while you click Pair on the Mac, and keep what it signs for us.
 */
export async function pairDevice(node: DhtNode, ticket: DeviceTicket | string, device: PhoneDevice, opts: { timeoutMs?: number; onWait?: (fingerprint: string) => void } & DialHints = {}): Promise<Paired> {
  const parsed = typeof ticket === 'string' ? parseDeviceTicket(ticket) : ticket;
  if (!parsed) throw new Error('That isn’t a Beluga pairing code or link');
  const secrets = await deviceSecrets(parsed);
  const target = signKeyPair(secrets.seed).publicKey;
  const link = device.keys.link;
  const hinted = parsed.via === 'link' && parsed.relay ? [parsed.relay] : [];
  let dialed;
  try {
    dialed = await dialMac({ node, target, keyPair: link, relays: [...hinted, ...(opts.relays ?? [])], ...dialOpts({ dialTimeoutMs: 25_000, ...opts }) });
  } catch (err) {
    if (err instanceof DialError) throw new DialError(NOT_FOUND, err.report);
    throw err;
  }
  const stream = dialed.stream;
  const sock = new Framed(stream, 64 * 1024, true);
  return new Promise<Paired>((resolve, reject) => {
    let settled = false;
    let fp = '';
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      sock.close(1000);
    };
    // Long enough to find the Mac and for you to click Pair (the pairing itself lasts 10 minutes).
    const timer = setTimeout(() => settle(() => reject(new Error(fp ? 'Nobody clicked Pair on the Mac in time' : NOT_FOUND))), opts.timeoutMs ?? 10 * 60_000);
    const send = (msg: DevicePair): void => sock.send(JSON.stringify(msg));
    {
      const hh = stream.handshakeHash;
      if (!hh || !sameBytes(stream.remotePublicKey, target)) return settle(() => reject(new Error(NOT_FOUND)));
      const hello = { t: 'dev_hello' as const, proto: COMPANION_PROTO.major, device: hex(device.keys.device.publicKey), box: hex(device.keys.box.publicKey), name: device.name.slice(0, 64), platform: device.platform, app: device.app.slice(0, 40) };
      send({ ...hello, mac: devProof(secrets.auth, 'phone', hh, canonical(hello)) });
    }
    sock.on('text', (text) => {
      const msg = parseDevicePair(text);
      const hh = stream.handshakeHash;
      if (!msg || !hh) return settle(() => reject(new Error('Your Mac answered something this app doesn’t understand: update it')));
      if (msg.t === 'dev_refused') return settle(() => reject(new PairRefused(msg.reason, msg.why)));
      if (msg.t === 'dev_wait') {
        fp = fingerprint(hh, link.publicKey, target);
        // The Mac shows the same four pictures: different ones mean someone is in the middle.
        if (msg.fingerprint !== fp) return settle(() => reject(new Error('The pairing’s fingerprint doesn’t match: try again')));
        opts.onWait?.(fp);
        return;
      }
      if (msg.t !== 'dev_ok') return settle(() => reject(new Error('Unexpected answer from your Mac')));
      const { mac, ...about } = msg;
      if (!checkDevProof(secrets.auth, 'mac', hh, canonical(about), mac)) return settle(() => reject(new Error('Your Mac couldn’t prove it made that pairing')));
      const c = msg.cert;
      if (!verifyCert(c) || c.link !== hex(link.publicKey) || c.device !== hex(device.keys.device.publicKey) || c.box !== hex(device.keys.box.publicKey)) {
        return settle(() => reject(new Error('The certificate from your Mac doesn’t check out')));
      }
      const relay = msg.relay ?? dialed.relay;
      settle(() => resolve({ cert: c, address: msg.address, macName: msg.macName, fingerprint: fp, path: dialed.path, ...(relay ? { relay } : {}) }));
    });
    sock.on('close', () => settle(() => reject(new Error(fp ? 'The pairing was closed on your Mac' : NOT_FOUND))));
  });
}

// ---- the link

export interface Welcome {
  readonly mac: { readonly name: string; readonly version: string };
  readonly me: { readonly name: string; readonly peerId: string };
  readonly v: { readonly major: number; readonly minor: number };
  /** The Mac's relay now (keep it for next time). */
  readonly relay?: string;
}

export interface Chunk {
  readonly off: number;
  readonly bytes: Bytes;
  readonly eof: boolean;
  readonly size: number;
  readonly mime: string;
}

interface ClientEvents extends Record<string, unknown[]> {
  /** A finished view for a topic (replacing the last one). */
  view: [Topic, unknown, number];
  nudge: [Extract<MacFrame, { t: 'nudge' }>];
  /** 1.7: a terminal's output or status (BLG-42). */
  term: [Extract<MacFrame, { t: 'term_data' | 'term_status' }>];
  /** 1.16: the Mac wants the phone to do something (BLG-150); answer with reply(). */
  req: [Extract<MacFrame, { t: 'req' }>];
  /** 1.16: a byte tunnel to the phone's debugging port (adb over the link). */
  tun: [Extract<MacFrame, { t: 'tun_open' | 'tun_data' | 'tun_ack' | 'tun_close' }>];
  /** 1.18: the Mac took a piece of the screen's video. */
  vidAck: [Extract<MacFrame, { t: 'vid_ack' }>];
  /** 1.46: your computers and where to dial each (BLG-809). */
  computers: [Extract<MacFrame, { t: 'computers' }>];
  /** The link closed: its code (4002: a version this Mac or app doesn't answer; 4010: this phone was removed) and why. */
  close: [number, string];
}

export interface CompanionClientOptions {
  readonly node: DhtNode;
  /** The Mac's companion address (hex, from pairing). */
  readonly address: string;
  /** The device's link key pair (the Mac's firewall knows its public key from the certificate). */
  readonly link: { readonly publicKey: Bytes; readonly secretKey: Bytes };
  readonly app: string;
  readonly platform: 'android' | 'ios';
  readonly topics?: readonly Topic[];
  readonly keepAliveMs?: number;
  readonly timeoutMs?: number;
  /** The relay and what worked last time (dial.ts). */
  readonly hints?: DialHints;
}

/** One link to your Mac, open while you look. */
export class CompanionClient extends Emitter<ClientEvents> {
  welcome?: Welcome;
  /** How the open link came, and what was tried (also sent to the Mac in hello). */
  path?: import('./protocol.js').LinkPath;
  tried: import('./protocol.js').DialAttempt[] = [];
  /** The relay that worked, or the one the Mac's record named. */
  relay?: string;
  private sock?: Framed;
  private dialing = 0;
  private nextId = 1;
  private topics: Topic[];
  private readonly calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; chunk?: (c: Chunk) => void }>();
  private beat?: ReturnType<typeof setInterval>;
  private heard = 0;

  constructor(private readonly opts: CompanionClientOptions) {
    super();
    this.topics = [...(opts.topics ?? ['home'])];
  }

  get connected(): boolean {
    return Boolean(this.sock?.isOpen && this.welcome);
  }

  /** Dial the Mac and say hello: resolves with its welcome, rejects when it can't be reached or turns us away. */
  async connect(): Promise<Welcome> {
    this.close();
    this.welcome = undefined;
    const attempt = ++this.dialing;
    const target = b4a.from(this.opts.address, 'hex');
    const hints = this.opts.hints ?? {};
    const dialed = await dialMac({ node: this.opts.node, target, keyPair: this.opts.link, relays: hints.relays ?? [], ...dialOpts(hints) });
    if (attempt !== this.dialing) {
      dialed.stream.destroy();
      throw new Error('Superseded by a newer connect');
    }
    this.path = dialed.path;
    this.tried = dialed.tried;
    if (dialed.relay) this.relay = dialed.relay;
    const stream = dialed.stream;
    const sock = new Framed(stream, MAX_COMPANION_FRAME + 1024, true);
    this.sock = sock;
    return new Promise<Welcome>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Your Mac isn’t answering (asleep, or offline)'));
          sock.terminate();
        }
      }, this.opts.timeoutMs ?? 20_000);
      {
        if (!sameBytes(stream.remotePublicKey, target)) {
          sock.terminate();
          return reject(new Error('Reached something that isn’t your Mac'));
        }
        this.heard = Date.now();
        this.send({ t: 'hello', v: { ...COMPANION_PROTO }, app: this.opts.app.slice(0, 40), platform: this.opts.platform, topics: this.topics, via: { path: dialed.path, tried: dialed.tried.slice(-8) } });
        this.beatEvery(this.opts.keepAliveMs ?? KEEPALIVE_MS);
      }
      sock.on('pong', () => (this.heard = Date.now()));
      sock.on('text', (text) => {
        this.heard = Date.now();
        const f = parseMacFrame(text);
        if (!f) return;
        if (f.t === 'welcome') {
          if (!compatible(COMPANION_PROTO, f.v, f.min)) {
            sock.close(4002, 'update');
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new Error(f.v.major > COMPANION_PROTO.major ? 'Update the Beluga app' : 'Update Beluga on your Mac'));
            }
            return;
          }
          this.welcome = { mac: f.mac, me: f.me, v: f.v, ...(f.relay ? { relay: f.relay } : {}) };
          if (f.relay) this.relay = f.relay;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(this.welcome);
          }
          return;
        }
        this.onFrame(f);
      });
      sock.on('close', (code, reason) => {
        clearInterval(this.beat);
        for (const c of this.calls.values()) c.reject(new Error('The link to your Mac closed'));
        this.calls.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(reason || (code === 1006 ? 'Your Mac isn’t answering (asleep, or offline)' : 'Your Mac closed the link')));
        }
        if (this.sock === sock) this.sock = undefined;
        this.emit('close', code, reason);
      });
    });
  }

  /** The topics on screen now (views for them arrive, and again when they change). */
  sub(topics: readonly Topic[]): void {
    this.topics = [...topics].slice(0, 16);
    if (this.welcome) this.send({ t: 'sub', topics: this.topics });
  }

  /** An API call (only `phone` methods get through; the rest are refused by the Mac). */
  call(method: string, args: readonly unknown[] = []): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not linked to your Mac'));
      this.calls.set(id, { resolve, reject });
      this.send({ t: 'call', id, method, args: [...args] });
    });
  }

  /** One piece of a file the Mac offered (`out:` ref): from `off`, as thumb, full or text. */
  get(ref: string, variant: 'thumb' | 'full' | 'text', off = 0): Promise<Chunk> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not linked to your Mac'));
      this.calls.set(id, { resolve: () => reject(new Error('No file came')), reject, chunk: resolve });
      this.send({ t: 'get', id, ref: ref as `out:${string}`, variant, off });
    });
  }

  /** A whole file (piece by piece; pictures are small, logs come in 192 KB pieces). */
  async getAll(ref: string, variant: 'thumb' | 'full' | 'text', max = 64 * 1024 * 1024): Promise<{ bytes: Bytes; mime: string; size: number }> {
    const parts: Bytes[] = [];
    let off = 0;
    for (;;) {
      const c = await this.get(ref, variant, off);
      parts.push(c.bytes);
      off += c.bytes.length;
      if (c.eof || !c.bytes.length || off >= max) return { bytes: b4a.concat(parts), mime: c.mime, size: c.size };
    }
  }

  /**
   * Send a photo or file to the Mac (in pieces) → its `up:` ref, for companion.ask / companion.post
   * (`files: [ref]`). Up to MAX_UPLOAD_BYTES.
   */
  async put(name: string, mime: string, bytes: Bytes): Promise<string> {
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('That file is too big to send (up to 25 MB)');
    const id = this.nextId++;
    for (let off = 0; ; off += COMPANION_PIECE) {
      const piece = bytes.subarray(off, off + COMPANION_PIECE);
      const eof = off + piece.length >= bytes.length;
      const value = (await new Promise<unknown>((resolve, reject) => {
        if (!this.connected) return reject(new Error('Not linked to your Mac'));
        this.calls.set(id, { resolve, reject });
        this.send({ t: 'put', id, name: name.slice(0, 200) || 'file', mime: mime.slice(0, 100), size: bytes.length, off, b64: b4a.toString(piece, 'base64'), eof });
      })) as { ref?: string } | undefined;
      if (eof) {
        if (!value?.ref) throw new Error('Your Mac didn’t take the file');
        return value.ref;
      }
    }
  }

  /** The app went to the background (the link closes after the grace) or came back. */
  focus(on: boolean): void {
    this.send({ t: 'focus', on });
    // Kept open while away (Stay connected, BLG-128): ping less, where the link allows and the Mac waits that long.
    const v = this.welcome?.v;
    const slow = !on && v !== undefined && v.major === COMPANION_PROTO.major && v.minor >= SINCE.awayBeat && (this.path === 'relay' || this.path === 'lan');
    this.beatEvery(this.opts.keepAliveMs ?? (slow ? KEEPALIVE_AWAY_MS : KEEPALIVE_MS));
  }

  /** Ping every `every` ms; a link silent for three of them is gone. */
  private beatEvery(every: number): void {
    const sock = this.sock;
    if (!sock) return;
    clearInterval(this.beat);
    this.beat = setInterval(() => {
      if (Date.now() - this.heard > every * 3) sock.terminate();
      else sock.ping();
    }, every);
  }

  /** 1.7: stream a worktree's terminal (a key companion.terminals or termOpen gave), type into it, stop. */
  termAttach(term: string): void {
    this.send({ t: 'term_attach', term });
  }

  termDetach(term: string): void {
    this.send({ t: 'term_detach', term });
  }

  termInput(term: string, data: string): void {
    for (let at = 0; at < data.length; at += 64_000) this.send({ t: 'term_input', term, data: data.slice(at, at + 64_000) });
  }

  /** Where to push to this phone while it's closed (Beluga Push). */
  registerPush(platform: 'fcm' | 'apns', token: string, relayKey: string): void {
    this.send({ t: 'push', platform, token, relayKey });
  }

  // ---- 1.16: your Mac using the phone (BLG-150)

  /** Tell the Mac what this phone lets it do, and how it can be reached (adb port, Wi-Fi IP). */
  sendControl(state: import('./protocol.js').PhoneControl): void {
    this.send({ t: 'control', state });
  }
  /** The Wireless-debugging pairing code the user typed, for the Mac's `adb pair`. */
  sendAdbCode(code: string): void {
    this.send({ t: 'adb_code', code });
  }
  /** 1.18: a piece of the screen's video, or its end. */
  video(f: Extract<PhoneFrame, { t: 'vid' | 'vid_end' }>): void {
    this.send(f);
  }
  /** Answer a `req` from the Mac. */
  reply(id: number, ok: boolean, value?: unknown, error?: string): void {
    this.send({ t: 'reply', id, ok, ...(value !== undefined ? { value } : {}), ...(error ? { error: error.slice(0, 2000) } : {}) });
  }
  /** The tunnel is connected to the phone's own debugging port. */
  tunOk(id: number): void {
    this.send({ t: 'tun_ok', id });
  }
  tunData(id: number, bytes: Bytes): void {
    for (let off = 0; off < bytes.length; off += TUN_PIECE) this.send({ t: 'tun_data', id, b64: b4a.toString(bytes.subarray(off, off + TUN_PIECE), 'base64') });
  }
  tunAck(id: number, n: number): void {
    this.send({ t: 'tun_ack', id, n: Math.min(n, 512 * 1024) });
  }
  tunClose(id: number, error?: string): void {
    this.send({ t: 'tun_close', id, ...(error ? { error: error.slice(0, 300) } : {}) });
  }

  /** Say goodbye and close (the app went away). */
  bye(): void {
    this.send({ t: 'bye' });
    this.sock?.close(1000, 'bye');
  }

  /**
   * Is the link still alive? One ping: true as soon as anything comes back within `ms`. A link
   * that doesn't answer is half-open (the phone was frozen in the background and the Mac dropped
   * its end): it's terminated, so `close` fires now rather than after the keepalive's minute.
   */
  probe(ms = 3_000): Promise<boolean> {
    const sock = this.sock;
    if (!sock?.isOpen || !this.welcome) return Promise.resolve(false);
    const since = this.heard;
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        offPong();
        offText();
        offClose();
        if (!ok && this.sock === sock) sock.terminate();
        resolve(ok);
      };
      const offPong = sock.on('pong', () => done(true));
      const offText = sock.on('text', () => done(true));
      const offClose = sock.on('close', () => done(false));
      const timer = setTimeout(() => done(this.heard > since), ms);
      sock.ping();
    });
  }

  /** Dial again (only when the app asks: coming to the front, a push, a retry). */
  reconnect(): Promise<Welcome> {
    return this.connect();
  }

  close(): void {
    // A dial still racing is dropped when it finishes.
    this.dialing++;
    clearInterval(this.beat);
    this.sock?.terminate();
    this.sock = undefined;
  }

  private send(f: PhoneFrame): void {
    this.sock?.send(JSON.stringify(f));
  }

  private onFrame(f: MacFrame): void {
    switch (f.t) {
      case 'view':
        return this.emit('view', f.topic, f.data, f.rev);
      case 'nudge':
        return this.emit('nudge', f);
      case 'term_data':
      case 'term_status':
        return this.emit('term', f);
      case 'req':
        return this.emit('req', f);
      case 'vid_ack':
        return this.emit('vidAck', f);
      case 'computers':
        return this.emit('computers', f);
      case 'tun_open':
      case 'tun_data':
      case 'tun_ack':
      case 'tun_close':
        return this.emit('tun', f);
      case 'result': {
        const c = this.calls.get(f.id);
        if (!c) return;
        this.calls.delete(f.id);
        if (f.ok) c.resolve(f.value);
        else c.reject(new Error(f.error ?? 'failed'));
        return;
      }
      case 'chunk': {
        const c = this.calls.get(f.id);
        if (!c?.chunk) return;
        this.calls.delete(f.id);
        c.chunk({ off: f.off, bytes: b4a.from(f.b64, 'base64'), eof: f.eof, size: f.size, mime: f.mime });
        return;
      }
      case 'bye':
        return;
      default:
        return;
    }
  }
}
