/**
 * The link worklet: runs in Holepunch's Bare runtime on the phone (react-native-bare-kit), so
 * hyperdht, its native UDP and sodium run unchanged. It holds the one Noise stream to your Mac
 * (src/companion/client.ts: pairing, hello/welcome, keepalive, calls, files) and speaks to the
 * app's screens over BareKit.IPC in the RPC of lib/link/rpc.ts.
 *
 * To the screens it looks exactly like the protocol (MacFrames in, PhoneFrames out), so the app's
 * store is the same for the real Mac and the demo one. Battery: the DHT node exists only while a
 * link or a pairing needs it; `close` destroys it (no UDP, no keepalives, no wakeups).
 *
 * Bundled with bare-pack (npm run worklet:bundle); typechecked by npm run typecheck:worklet.
 */
import b4a from 'b4a';
import tcp from 'bare-tcp';
import DHT from 'hyperdht';
import { CompanionClient, DialError, PairRefused, pairDevice } from '../../../src/companion/client';
import { type MessagePipe, dhtHealth } from '../../../src/companion/dial';
import { type MediaSocket, PieceCache, serveMediaSocket, tokenOf } from '../../../src/companion/media-stream';
import { deviceKeys, fromHex, hex, newSeed } from '../../../src/companion/device-crypto';
import { KEEPALIVE_MS, type MacFrame, type PhoneFrame } from '../../../src/companion/protocol';
import { encodeLine, type LinkHints, lineDecoder, type UiToWorklet, type Way, type WorkletToUi } from '../lib/link/rpc';

declare const BareKit: { readonly IPC: { on(event: 'data', fn: (data: Uint8Array) => void): void; write(data: string | Uint8Array): void } };

const APP = 'beluga-companion/0.1.0';
const ipc = BareKit.IPC;
const post = (msg: WorkletToUi): void => void ipc.write(b4a.from(encodeLine(msg), 'utf8'));
const frame = (f: MacFrame): void => post({ ev: 'frame', json: JSON.stringify(f) });
const log = (line: string): void => post({ ev: 'log', line });

let node: DHT | undefined;
let client: CompanionClient | undefined;
const pairings = new Set<number>();
/** Files coming from the screens, by `put` id, until their last piece. */
const puts = new Map<number, Uint8Array[]>();

const dht = (): DHT => (node ??= new DHT());

// ---- videos, streamed to the phone's player (src/companion/media-stream.ts)

/** Pieces come over the link that's open now; what came is kept for seeking back and playing again. */
const mediaCache = new PieceCache(async (ref, off) => {
  const c = client;
  if (!c) throw new Error('Your Mac is away');
  const piece = await c.get(ref, 'full', off);
  return { bytes: piece.bytes, size: piece.size, mime: piece.mime };
});
let media: Promise<string> | undefined;

/** The loopback server, started on the first video and gone with the worklet: http://127.0.0.1:<port>/<token>. */
function mediaBase(): Promise<string> {
  media ??= new Promise<string>((resolve, reject) => {
    const token = tokenOf(newSeed());
    const server = tcp.createServer((socket) => serveMediaSocket(socket as unknown as MediaSocket, { token, cache: mediaCache }));
    server.on('error', (e: Error) => reject(e));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      if (port) resolve(`http://127.0.0.1:${port}/${token}`);
      else reject(new Error('No port for videos'));
    });
  }).catch((e: Error) => {
    media = undefined;
    throw e;
  });
  return media;
}

// ---- the relay's WebSocket, opened by the screens' side (React Native has one, Bare has none)

const sockets = new Map<number, { open?: () => void; message?: (d: Uint8Array) => void; close?: (code?: number) => void }>();
let socketSeq = 0;

/** A WebSocket to the relay, through the app: bytes go over the IPC in base64. */
function openRelay(url: string): MessagePipe {
  const id = ++socketSeq;
  const s: { open?: () => void; message?: (d: Uint8Array) => void; close?: (code?: number) => void } = {};
  sockets.set(id, s);
  post({ ev: 'ws.open', id, url });
  return {
    send: (data) => post({ ev: 'ws.send', id, b64: b4a.toString(data, 'base64') }),
    close: () => {
      if (sockets.delete(id)) post({ ev: 'ws.close', id });
    },
    onOpen: (fn) => void (s.open = fn),
    onMessage: (fn) => void (s.message = fn),
    onClose: (fn) => void (s.close = fn),
  };
}

function onSocket(msg: Extract<UiToWorklet, { op: 'ws.event' }>): void {
  const s = sockets.get(msg.id);
  if (!s) return;
  if (msg.kind === 'open') s.open?.();
  else if (msg.kind === 'message' && msg.b64) s.message?.(b4a.from(msg.b64, 'base64'));
  else if (msg.kind === 'close') {
    sockets.delete(msg.id);
    s.close?.(msg.code);
  }
}

/** Which network this is (its local subnets), so the way that worked here is tried first next time. */
function network(n: DHT): string {
  try {
    const list = (n as unknown as { udx?: { networkInterfaces?: () => Array<{ name: string; host: string; family: number; internal: boolean }> } }).udx?.networkInterfaces?.() ?? [];
    const nets = list.filter((i) => !i.internal && i.family === 4).map((i) => `${i.name}:${i.host.split('.').slice(0, 3).join('.')}`);
    return nets.sort().join(',') || 'none';
  } catch {
    return 'unknown';
  }
}

/** How to dial: the relays we know, and the way that worked on this network. */
function dialHints(n: DHT, hints: LinkHints | undefined, extraRelay?: string) {
  const net = network(n);
  const prefer = hints?.prefer[net];
  return { net, hints: { openRelay, relays: [...(extraRelay ? [extraRelay] : []), ...(hints?.relays ?? [])], ...(prefer ? { prefer } : {}), probeDht: () => dhtHealth(n) } };
}

const wayOf = (path: 'lan' | 'direct' | 'relay'): Way => (path === 'relay' ? 'relay' : 'p2p');

/** Nothing needs the network: the DHT node goes, and with it every socket and timer. */
async function quiet(): Promise<void> {
  if (client || pairings.size || !node) return;
  const n = node;
  node = undefined;
  await n.destroy().catch(() => undefined);
}

function open(msg: Extract<UiToWorklet, { op: 'open' }>): void {
  client?.close();
  const hello = JSON.parse(msg.hello) as Extract<PhoneFrame, { t: 'hello' }>;
  const keys = deviceKeys(fromHex(msg.secret.seed));
  const n = dht();
  const { net, hints } = dialHints(n, msg.hints, msg.pairing.relay);
  const c = new CompanionClient({ node: n, address: msg.pairing.address, link: keys.link, app: APP, platform: hello.platform, topics: hello.topics, keepAliveMs: KEEPALIVE_MS, hints });
  client = c;
  // The screens' number for this open (rpc.ts `gen`), echoed in its phases.
  const gen = msg.gen;
  const tag = gen !== undefined ? { gen } : {};
  c.on('view', (topic, data, rev) => frame({ t: 'view', topic, rev, data }));
  c.on('nudge', (f) => frame(f));
  c.on('term', (f) => frame(f));
  // 1.16 (BLG-150): the Mac wants the phone to act — hand it to the screens (the native side is there).
  c.on('req', (f) => frame(f));
  c.on('vidAck', (f) => frame(f));
  // 1.46 (BLG-809): where your computers are, for the screens to link each by itself.
  c.on('computers', (f) => frame(f));
  // 1.16: a byte tunnel to the phone's own debugging port (adb over the link). The worklet has bare-tcp.
  c.on('tun', (f) => onTunnel(c, f));
  c.on('close', (code, reason) => {
    if (client !== c) return;
    client = undefined;
    // 4010: this phone was removed on the Mac. 4002: versions don't match.
    post({ ev: 'phase', phase: code === 4010 || code === 4002 ? 'refused' : 'closed', detail: reason || undefined, code, ...tag });
    void quiet();
  });
  post({ ev: 'phase', phase: 'dialing', ...tag });
  c.connect().then(
    (w) => {
      // A newer open replaced this one while it dialed: only the newest speaks.
      if (client !== c) return;
      if (c.path) post({ ev: 'path', path: c.path, way: wayOf(c.path), tried: c.tried, ...(c.relay ? { relay: c.relay } : {}), network: net });
      post({ ev: 'phase', phase: 'open', ...tag });
      frame({ t: 'welcome', v: { ...w.v }, min: { ...w.v }, mac: w.mac, me: w.me, ...(w.relay ? { relay: w.relay } : {}) });
    },
    (e: Error) => {
      if (client !== c) return;
      client = undefined;
      const update = /^Update /.test(e.message);
      post({ ev: 'phase', phase: update ? 'refused' : 'unreachable', detail: e.message, ...(e instanceof DialError ? { report: e.report } : {}), ...(update ? { code: 4002 } : {}), ...tag });
      void quiet();
    },
  );
}

/**
 * The adb-over-link tunnel (BLG-150): the Mac opened a tunnel to the phone's Wireless-debugging
 * port, so the worklet dials 127.0.0.1:<that port> here and pumps bytes both ways. adb's own TLS
 * stays end to end between the Mac's adb and the phone's adbd; the link carries only the ciphertext.
 */
const tunnels = new Map<number, { socket: InstanceType<typeof tcp.Socket> }>();
/** The phone's debugging ports, from the last `control` the screens sent (NSD found them). */
let adbPort: number | undefined;
let adbPairPort: number | undefined;

function onTunnel(c: CompanionClient, f: Extract<MacFrame, { t: 'tun_open' | 'tun_data' | 'tun_ack' | 'tun_close' }>): void {
  if (f.t === 'tun_open') {
    const port = f.to === 'adb-pair' ? adbPairPort : adbPort;
    if (!port) return c.tunClose(f.id, 'Wireless debugging isn’t listening');
    const socket = new tcp.Socket();
    tunnels.set(f.id, { socket });
    socket.on('connect', () => c.tunOk(f.id));
    socket.on('data', (d: unknown) => c.tunData(f.id, d as Uint8Array));
    socket.on('error', () => {
      if (tunnels.delete(f.id)) c.tunClose(f.id, 'connection failed');
    });
    socket.on('close', () => {
      if (tunnels.delete(f.id)) c.tunClose(f.id);
    });
    socket.connect(port, '127.0.0.1');
    return;
  }
  const t = tunnels.get(f.id);
  if (f.t === 'tun_data') {
    if (t) {
      t.socket.write(b4a.from(f.b64, 'base64'));
      c.tunAck(f.id, 1);
    }
    return;
  }
  if (f.t === 'tun_close') {
    if (tunnels.delete(f.id)) t?.socket.destroy();
  }
  // tun_ack: the Mac took our bytes; bare-tcp handles its own backpressure, so nothing to do.
}

function onFrame(json: string): void {
  const c = client;
  if (!c) return;
  const f = JSON.parse(json) as PhoneFrame;
  switch (f.t) {
    case 'sub':
      return c.sub(f.topics);
    case 'control':
      adbPort = f.state.adb.port;
      adbPairPort = f.state.adb.pairing;
      return c.sendControl(f.state);
    case 'adb_code':
      return c.sendAdbCode(f.code);
    case 'reply':
      return c.reply(f.id, f.ok, f.value, f.error);
    case 'vid':
    case 'vid_end':
      return c.video(f);
    case 'call':
      c.call(f.method, f.args).then(
        (value) => frame({ t: 'result', id: f.id, ok: true, value }),
        (e: Error) => frame({ t: 'result', id: f.id, ok: false, error: e.message.slice(0, 2000) }),
      );
      return;
    case 'get':
      c.get(f.ref, f.variant, f.off).then(
        (piece) => frame({ t: 'chunk', id: f.id, off: piece.off, b64: b4a.toString(piece.bytes, 'base64'), eof: piece.eof, size: piece.size, mime: piece.mime }),
        (e: Error) => frame({ t: 'result', id: f.id, ok: false, error: e.message.slice(0, 2000) }),
      );
      return;
    case 'put': {
      // The screens send a file piece by piece (as the protocol does); the client sends it whole
      // with its own pieces (client.put), so collect, answer each piece, and put on the last.
      const got = puts.get(f.id) ?? [];
      got.push(b4a.from(f.b64, 'base64'));
      puts.set(f.id, got);
      if (!f.eof) return frame({ t: 'result', id: f.id, ok: true, value: { received: f.off + got.at(-1)!.length } });
      puts.delete(f.id);
      c.put(f.name, f.mime, b4a.concat(got)).then(
        (ref) => frame({ t: 'result', id: f.id, ok: true, value: { ref } }),
        (e: Error) => frame({ t: 'result', id: f.id, ok: false, error: e.message.slice(0, 2000) }),
      );
      return;
    }
    case 'focus':
      return c.focus(f.on);
    case 'term_attach':
      return c.termAttach(f.term);
    case 'term_detach':
      return c.termDetach(f.term);
    case 'term_input':
      return c.termInput(f.term, f.data);
    case 'push':
      return c.registerPush(f.platform, f.token, f.relayKey);
    case 'bye':
      return c.bye();
    default:
      return;
  }
}

function pair(msg: Extract<UiToWorklet, { op: 'pair' }>): void {
  const seed = msg.secret?.seed ?? hex(newSeed());
  const keys = deviceKeys(fromHex(seed));
  pairings.add(msg.id);
  const n = dht();
  const { net, hints } = dialHints(n, msg.hints);
  pairDevice(n, msg.link ?? msg.code ?? '', { keys, name: msg.name, platform: msg.platform, app: APP }, { ...hints, onWait: (fingerprint) => pairings.has(msg.id) && post({ ev: 'pair.wait', id: msg.id, fingerprint, secret: { seed } }) })
    .then(
      (p) => {
        if (!pairings.has(msg.id)) return;
        post({ ev: 'path', path: p.path, way: wayOf(p.path), tried: [], ...(p.relay ? { relay: p.relay } : {}), network: net });
        post({ ev: 'pair.ok', id: msg.id, pairing: { cert: p.cert, address: p.address, macName: p.macName, ...(p.relay ? { relay: p.relay } : {}) }, secret: { seed } });
      },
      (e: Error) =>
        pairings.has(msg.id) &&
        post({ ev: 'pair.fail', id: msg.id, reason: e.message, ...(e instanceof DialError ? { report: e.report } : {}), ...(e instanceof PairRefused && e.why ? { refusal: e.why } : {}) }),
    )
    .finally(() => {
      pairings.delete(msg.id);
      void quiet();
    });
}

ipc.on(
  'data',
  lineDecoder((line) => {
    let msg: UiToWorklet;
    try {
      msg = JSON.parse(line) as UiToWorklet;
    } catch {
      return;
    }
    try {
      switch (msg.op) {
        case 'open':
          return open(msg);
        case 'frame':
          return onFrame(msg.json);
        case 'close':
          puts.clear();
          mediaCache.clear();
          for (const [, t] of tunnels) t.socket.destroy();
          tunnels.clear();
          adbPort = adbPairPort = undefined;
          client?.bye();
          client?.close();
          client = undefined;
          for (const [id, s] of [...sockets]) {
            sockets.delete(id);
            s.close?.(1000);
            post({ ev: 'ws.close', id });
          }
          post({ ev: 'phase', phase: 'closed', detail: msg.reason, ...(msg.gen !== undefined ? { gen: msg.gen } : {}) });
          void quiet();
          return;
        case 'probe': {
          const c = client;
          const id = msg.id;
          if (!c) return post({ ev: 'probe', id, ok: false });
          void c.probe(msg.ms).then((ok) => post({ ev: 'probe', id, ok }));
          return;
        }
        case 'pair':
          return pair(msg);
        case 'ws.event':
          return onSocket(msg);
        case 'media':
          mediaBase().then(
            (base) => post({ ev: 'media', id: msg.id, base }),
            (e: Error) => post({ ev: 'media', id: msg.id, error: e.message }),
          );
          return;
        case 'pair.cancel':
          pairings.delete(msg.id);
          void quiet();
          return;
      }
    } catch (e) {
      log(`error: ${(e as Error).message}`);
    }
  }),
);

post({ ev: 'ready', version: APP });
