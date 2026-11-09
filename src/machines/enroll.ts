import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { type DeviceKeys, canonical, checkDevProof, checkKeyProof, devProof, deviceSecrets, fingerprint, hex, parseComputerTicket, signKeyPair } from '../companion/device-crypto.js';
import { DialError, type OpenRelay, dialMac } from '../companion/dial.js';
import { COMPANION_PROTO, type DeviceCert, type MachinePair, parseMachinePair } from '../companion/protocol.js';
import { wsPipe } from '../companion/relay.js';
import { type MessageSocket, fromStream } from '../net/transport.js';
import type { MachineRecord } from './book.js';
import type { DeviceSet } from './controllers.js';

/**
 * The app's side of joining a computer (BLG-774): dial the pairing the computer opened (its link or
 * code, direct or through its relay), show who we are, check the computer holds the keys it names,
 * show you its four pictures, and once you say Join, sign it in with your identity and hand it your
 * device set. The computer is then in the set (it signs nothing itself) and in machines.json.
 */

const MAX_PAIR_BYTES = 256 * 1024;
const NOT_FOUND = 'That computer isn’t answering. Check the code, or run `beluga pair --computer` there again (it works for 10 minutes).';

/** What the computer said about itself, shown with the four pictures while you decide. */
export interface ComputerOffer {
  readonly name: string;
  readonly platform: 'macos' | 'linux' | 'windows';
  readonly version: string;
  readonly fingerprint: string;
  /** Added over SSH (BLG-781): the computer printed the same four pictures there too. */
  readonly sshChecked?: boolean;
}

export interface JoinComputerOptions {
  readonly node?: Parameters<typeof dialMac>[0]['node'];
  readonly ticket: string;
  readonly set: DeviceSet;
  readonly keys: DeviceKeys;
  /** This app as it introduces itself: its certificate (DeviceSet.appCert) and where the computer reaches it back. */
  readonly app: DeviceCert;
  readonly address?: string;
  readonly relay?: string;
  /** You decide, having compared the pictures: true signs the computer in. */
  readonly decide: (offer: ComputerOffer) => Promise<boolean>;
  readonly openRelay?: OpenRelay;
  readonly staggerMs?: number;
  readonly timeoutMs?: number;
  readonly refuseDirect?: boolean;
}

export interface JoinedComputer {
  readonly record: MachineRecord;
  readonly fingerprint: string;
}

/** Node's WebSocket as the relay pipe dialMac wants. */
export const nodeOpenRelay: OpenRelay = (url) => wsPipe(new WebSocket(url), false);

export async function joinComputer(opts: JoinComputerOptions): Promise<JoinedComputer> {
  const ticket = parseComputerTicket(opts.ticket);
  if (!ticket) throw new Error('That isn’t a computer’s pairing link or code (run `beluga pair --computer` on it)');
  const secrets = await deviceSecrets(ticket, 'computer');
  const target = signKeyPair(secrets.seed).publicKey;
  let dialed;
  try {
    dialed = await dialMac({
      ...(opts.node ? { node: opts.node } : {}),
      target,
      keyPair: opts.keys.link,
      relays: ticket.via === 'link' && ticket.relay ? [ticket.relay] : [],
      openRelay: opts.openRelay ?? nodeOpenRelay,
      timeoutMs: 25_000,
      ...(opts.staggerMs !== undefined ? { staggerMs: opts.staggerMs } : {}),
      ...(opts.refuseDirect ? { noP2p: true } : {}),
    });
  } catch (err) {
    if (err instanceof DialError) throw new DialError(NOT_FOUND, err.report);
    throw err;
  }
  const stream = dialed.stream;
  const socket = fromStream(stream as unknown as Duplex, { maxBytes: MAX_PAIR_BYTES, open: true });
  socket.on('error', () => undefined);
  return new Promise<JoinedComputer>((resolve, reject) => {
    let settled = false;
    let issued: DeviceCert | undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Signed in but never confirmed: forget it again, so a half-joined computer holds nothing.
      if (issued) {
        try {
          opts.set.forget(issued.device);
        } catch {
          // already gone
        }
      }
      fn();
      socket.close(1000);
    };
    const fail = (message: string): void => settle(() => reject(new Error(message)));
    const timer = setTimeout(() => fail('The computer stopped answering'), opts.timeoutMs ?? 10 * 60_000);
    const send = (s: MessageSocket, msg: MachinePair): void => s.send(JSON.stringify(msg));
    const hh = stream.handshakeHash;
    if (!hh || !stream.remotePublicKey || hex(stream.remotePublicKey) !== hex(target)) return fail(NOT_FOUND);
    const hello = { t: 'mp_hello' as const, proto: COMPANION_PROTO.major, app: opts.app, name: opts.app.name, ...(opts.address ? { address: opts.address } : {}), ...(opts.relay ? { relay: opts.relay } : {}) };
    send(socket, { ...hello, mac: devProof(secrets.auth, 'app', hh, canonical(hello)) });
    let offered: Extract<MachinePair, { t: 'mp_keys' }> | undefined;
    let fp = '';
    socket.on('message', (text) => {
      const msg = parseMachinePair(text);
      if (!msg) return fail('The computer answered something this app doesn’t understand: update one of them');
      if (msg.t === 'mp_refused') return fail(msg.reason);
      if (msg.t === 'mp_done' && issued) {
        const cert = issued;
        issued = undefined;
        const k = offered!;
        const record: MachineRecord = { cert, address: k.address, relays: k.relay ? [k.relay] : dialed.relay ? [dialed.relay] : [], name: k.name, version: k.version, pairedAt: cert.issuedAt, lastSeen: Date.now() };
        return settle(() => resolve({ record, fingerprint: fp }));
      }
      if (msg.t !== 'mp_keys' || offered) return fail('Unexpected answer from the computer');
      const { mac, ...about } = msg;
      if (!checkDevProof(secrets.auth, 'computer', hh, canonical(about), mac)) return fail('The computer couldn’t prove it opened that pairing');
      if (!checkKeyProof('device', hh, msg.device, msg.deviceSig) || !checkKeyProof('link', hh, msg.link, msg.linkSig)) return fail('The computer couldn’t prove its keys are its own');
      if (msg.proto !== COMPANION_PROTO.major) return fail(msg.proto < COMPANION_PROTO.major ? `${msg.name} runs an older Beluga: run \`beluga update\` there, then pair again` : `${msg.name} runs a newer Beluga: update this app, then pair again`);
      offered = msg;
      fp = fingerprint(hh, opts.keys.link.publicKey, target);
      void opts.decide({ name: msg.name, platform: msg.platform, version: msg.version, fingerprint: fp }).then(
        (yes) => {
          if (settled) return;
          if (!yes) {
            send(socket, { t: 'mp_refused', reason: 'Not added: the app said no', why: 'declined' });
            return fail('Not added');
          }
          let roster;
          try {
            const cert = opts.set.issue({ device: msg.device, link: msg.link, box: msg.box, name: msg.name, platform: msg.platform, role: 'computer' });
            roster = opts.set.add(cert);
            issued = cert;
          } catch (err) {
            return fail(err instanceof Error ? err.message : 'Could not sign the computer in');
          }
          const ok = { t: 'mp_ok' as const, cert: issued, roster };
          send(socket, { ...ok, mac: devProof(secrets.auth, 'app', hh, canonical(ok)) });
        },
        (err: unknown) => fail(err instanceof Error ? err.message : 'Not added'),
      );
    });
    socket.on('close', () => fail(offered ? 'The pairing was closed on the computer' : NOT_FOUND));
  });
}
