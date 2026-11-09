/// <reference path="../net/mesh/modules.d.ts" />
import { randomBytes, randomInt } from 'node:crypto';
import type DHT from 'hyperdht';
import type { KeyPair, NoiseSocket, Server } from 'hyperdht';
import { CODE_ALPHABET, CODE_LENGTH, type DeviceKeys, type DeviceTicket, PAIR_TTL_MS, canonical, checkDevProof, computerLink, devProof, deviceSecrets, fingerprint, formatCode, hex, keyProofText, roleOf, signKeyPair, signWith, verifyCert } from '../companion/device-crypto.js';
import type { RelayRoute } from '../companion/relay.js';
import { COMPANION_PROTO, type MachinePair, parseMachinePair } from '../companion/protocol.js';
import type { Identity } from '../net/crypto.js';
import { type MessageSocket, fromStream } from '../net/transport.js';
import type { DeviceSet } from './controllers.js';

/**
 * A computer's side of joining your devices (BLG-774): `beluga pair --computer` on it opens a
 * one-time pairing, a link (`beluga://computer#…`, also as a QR) and a 12-character code, good for
 * 10 minutes and one app. As a phone's pairing (companion/pair.ts), each turns into a temporary key
 * pair this computer listens on, so only someone holding it can find it. Then, over that Noise
 * connection, the app proves it holds the secret and shows its certificate; this computer answers
 * with its keys, signing the handshake with each; both show the same four pictures; you click Join
 * in the app, and your identity signs this computer in and hands it your device set.
 */

const MAX_PAIR_BYTES = 256 * 1024;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;

export interface ComputerPairingInfo {
  readonly link: string;
  readonly code: string;
  readonly expiresAt: number;
  /** The code listens too (its Argon2id takes a moment after the link): typing it works from now. */
  readonly codeReady?: boolean;
  /** An app has found it and waits for you: its name and the four pictures it shows too. */
  readonly waiting?: { readonly name: string; readonly fingerprint: string };
}

/** How the last pairing ended, for `beluga pair --computer` to say. */
export type ComputerPairingEnd = { readonly kind: 'joined'; readonly app: string; readonly owner: string; readonly at: number } | { readonly kind: 'declined' | 'expired' | 'cancelled'; readonly at: number };

export interface ComputerPairingOptions {
  readonly node: () => Promise<DHT>;
  /** This computer's own identity: until a pairing makes it someone's, the set is its own. */
  readonly identity: Identity;
  readonly set: DeviceSet;
  readonly keys: DeviceKeys;
  /** Its companion address (hex), where the app dials it from now on; its name, platform and version. */
  readonly address: () => string;
  readonly name: () => string;
  readonly platform: 'macos' | 'linux' | 'windows';
  readonly version: string;
  readonly onChange: () => void;
  /** It joined a set: the app's certificate and where it may be dialed back. */
  readonly onJoined?: (app: Extract<MachinePair, { t: 'mp_hello' }>) => void;
  readonly ttlMs?: number;
  readonly relay?: { add(route: RelayRoute): void; remove(publicKey: Buffer): void };
  readonly relayUrl?: () => string | undefined;
  readonly refuseDirect?: boolean;
  readonly log?: (line: string) => void;
}

interface Waiting {
  readonly socket: MessageSocket;
  readonly hello: Extract<MachinePair, { t: 'mp_hello' }>;
  readonly link: string;
  readonly hh: Buffer;
  readonly auth: Uint8Array;
  readonly fingerprint: string;
}

interface Open {
  readonly secret: string;
  readonly code: string;
  readonly expiresAt: number;
  readonly servers: Server[];
  readonly keyPairs: KeyPair[];
  readonly timer: NodeJS.Timeout;
  failures: number[];
  waiting?: Waiting;
  codeReady?: boolean;
}

const send = (socket: MessageSocket, msg: MachinePair): void => socket.send(JSON.stringify(msg));

export class ComputerPairing {
  private open?: Open;
  private ended?: ComputerPairingEnd;

  constructor(private readonly opts: ComputerPairingOptions) {}

  info(): ComputerPairingInfo | undefined {
    const o = this.open;
    if (!o) return undefined;
    return { link: computerLink(o.secret, this.opts.relayUrl?.()), code: formatCode(o.code), expiresAt: o.expiresAt, ...(o.codeReady ? { codeReady: true } : {}), ...(o.waiting ? { waiting: { name: o.waiting.hello.name, fingerprint: o.waiting.fingerprint } } : {}) };
  }

  /** How the last pairing ended (none while one is open). */
  last(): ComputerPairingEnd | undefined {
    return this.open ? undefined : this.ended;
  }

  get isOpen(): boolean {
    return this.open !== undefined;
  }

  keyPairs(): readonly KeyPair[] {
    return this.open?.keyPairs ?? [];
  }

  /** Open a new pairing (an open one closes first); returns once the link listens, the code following. */
  async start(): Promise<ComputerPairingInfo> {
    await this.cancel();
    this.ended = undefined;
    const secret = randomBytes(16).toString('base64url');
    const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const expiresAt = Date.now() + (this.opts.ttlMs ?? PAIR_TTL_MS);
    const servers: Server[] = [];
    const timer = setTimeout(() => void this.close('expired'), Math.max(0, expiresAt - Date.now()));
    timer.unref();
    const open: Open = { secret, code, expiresAt, servers, keyPairs: [], timer, failures: [] };
    this.open = open;
    const node = this.opts.node();
    const listen = async (ticket: DeviceTicket): Promise<void> => {
      const [dht, secrets] = await Promise.all([node, deviceSecrets(ticket, 'computer')]);
      if (this.open !== open) return;
      const raw = signKeyPair(secrets.seed);
      const keyPair: KeyPair = { publicKey: Buffer.from(raw.publicKey), secretKey: Buffer.from(raw.secretKey) };
      const accept = (stream: NoiseSocket): void => this.serve(open, secrets.auth, keyPair.publicKey, stream);
      const server = dht.createServer(this.opts.refuseDirect ? { firewall: () => true } : {}, accept);
      servers.push(server);
      open.keyPairs.push(keyPair);
      this.opts.relay?.add({ keyPair, accept });
      await server.listen(keyPair);
    };
    const byLink = listen({ via: 'link', secret });
    const byCode = listen({ via: 'code', code });
    try {
      await byLink;
    } catch (err) {
      byCode.catch(() => undefined);
      if (this.open === open) await this.cancel();
      throw err;
    }
    if (this.open !== open) throw new Error('The pairing was closed while it opened');
    byCode.then(
      () => {
        if (this.open !== open) return;
        open.codeReady = true;
        this.opts.onChange();
      },
      (err: unknown) => this.open === open && this.opts.log?.(`machines: the pairing code couldn't listen (the link still works): ${err instanceof Error ? err.message : String(err)}`),
    );
    this.opts.onChange();
    return this.info()!;
  }

  /** Close the pairing (an app waiting hears no). */
  cancel(reason = 'The pairing was closed on the computer'): Promise<void> {
    return this.close('cancelled', reason);
  }

  private async close(kind: 'cancelled' | 'expired' | 'declined' | 'joined', reason = 'The pairing was closed on the computer', joined?: { app: string; owner: string }): Promise<void> {
    const o = this.open;
    if (!o) return;
    this.open = undefined;
    this.ended = kind === 'joined' && joined ? { kind, ...joined, at: Date.now() } : kind === 'joined' ? undefined : { kind, at: Date.now() };
    clearTimeout(o.timer);
    for (const kp of o.keyPairs) this.opts.relay?.remove(kp.publicKey);
    if (o.waiting && kind !== 'joined') {
      send(o.waiting.socket, { t: 'mp_refused', reason, why: kind === 'expired' ? 'expired' : 'cancelled' });
      o.waiting.socket.close(1000);
    }
    this.opts.onChange();
    await Promise.all(o.servers.map((s) => s.close().catch(() => undefined)));
  }

  private serve(open: Open, auth: Uint8Array, pairingKey: Buffer, stream: NoiseSocket): void {
    const socket = fromStream(stream, { maxBytes: MAX_PAIR_BYTES, open: true });
    socket.on('error', () => undefined);
    const refuse = (reason: string, why?: Extract<MachinePair, { t: 'mp_refused' }>['why']): void => {
      send(socket, { t: 'mp_refused', reason, ...(why ? { why } : {}) });
      socket.close(1000);
    };
    const timer = setTimeout(() => socket.terminate(), Math.max(1000, open.expiresAt - Date.now()));
    timer.unref();
    socket.once('close', () => {
      clearTimeout(timer);
      if (open.waiting?.socket === socket) {
        open.waiting = undefined;
        if (this.open === open) this.opts.onChange();
      }
    });
    const failed = (): void => {
      open.failures = [...open.failures.filter((t) => Date.now() - t < FAILURE_WINDOW_MS), Date.now()];
      refuse("That pairing couldn't be verified", 'unverified');
    };
    socket.on('message', (text) => {
      if (this.open !== open) return refuse('That pairing has closed; run `beluga pair --computer` there again', 'expired');
      const msg = parseMachinePair(text);
      const hh = stream.handshakeHash;
      if (!msg || !hh) return failed();
      if (msg.t === 'mp_hello') return this.hello(open, socket, msg, stream, hh, auth, pairingKey, failed, refuse);
      if (open.waiting?.socket !== socket) return failed();
      if (msg.t === 'mp_refused') {
        socket.close(1000);
        void this.close('declined');
        return;
      }
      if (msg.t !== 'mp_ok') return failed();
      const { mac, ...about } = msg;
      if (!checkDevProof(auth, 'app', hh, canonical(about), mac)) return failed();
      if (msg.cert.owner !== open.waiting.hello.app.owner) return refuse('That certificate is from someone else', 'unverified');
      try {
        this.opts.set.joined(msg.cert, msg.roster);
      } catch (err) {
        return refuse(err instanceof Error ? err.message.slice(0, 200) : 'Could not join', 'unverified');
      }
      const hello = open.waiting.hello;
      send(socket, { t: 'mp_done' });
      socket.close(1000);
      open.waiting = undefined;
      void this.close('joined', undefined, { app: hello.name, owner: hello.app.owner });
      this.opts.onJoined?.(hello);
    });
  }

  private hello(open: Open, socket: MessageSocket, msg: Extract<MachinePair, { t: 'mp_hello' }>, stream: NoiseSocket, hh: Buffer, auth: Uint8Array, pairingKey: Buffer, failed: () => void, refuse: (reason: string, why?: Extract<MachinePair, { t: 'mp_refused' }>['why']) => void): void {
    if (open.failures.filter((t) => Date.now() - t < FAILURE_WINDOW_MS).length >= MAX_FAILURES) return refuse('Too many tries; run `beluga pair --computer` there again', 'tries');
    const { mac, ...about } = msg;
    if (!checkDevProof(auth, 'app', hh, canonical(about), mac)) return failed();
    const link = stream.remotePublicKey.toString('hex');
    // Only an app of yours joins a computer: its certificate, for the very key it dialed with.
    if (!verifyCert(msg.app) || roleOf(msg.app) !== 'app' || msg.app.link !== link) return refuse('Only a Beluga app can add this computer', 'unverified');
    if (msg.proto !== COMPANION_PROTO.major) return refuse(msg.proto > COMPANION_PROTO.major ? 'Update Beluga on this computer (`beluga update`) to add it' : 'Update the Beluga app to add this computer', 'version');
    const owner = this.opts.set.owner();
    if (owner.peerId !== this.opts.identity.peerId && owner.peerId !== msg.app.owner) return refuse('This computer is already someone else’s; forget it there first', 'owned');
    const before = open.waiting;
    if (before && before.link !== link) return refuse('Another app is adding this computer right now', 'busy');
    const { keys } = this.opts;
    const relay = this.opts.relayUrl?.();
    const reply = {
      t: 'mp_keys' as const,
      proto: COMPANION_PROTO.major,
      device: hex(keys.device.publicKey),
      link: hex(keys.link.publicKey),
      box: hex(keys.box.publicKey),
      name: this.opts.name().slice(0, 64) || 'Computer',
      platform: this.opts.platform,
      version: this.opts.version.slice(0, 40),
      address: this.opts.address(),
      ...(relay ? { relay } : {}),
      deviceSig: signWith(keys.device.secretKey, keyProofText('device', hh)),
      linkSig: signWith(keys.link.secretKey, keyProofText('link', hh)),
    };
    open.waiting = { socket, hello: msg, link, hh, auth, fingerprint: fingerprint(hh, stream.remotePublicKey, pairingKey) };
    send(socket, { ...reply, mac: devProof(auth, 'computer', hh, canonical(reply)) });
    if (before) before.socket.close(1000);
    this.opts.onChange();
  }
}
