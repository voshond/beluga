import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import { type Exit, type Io, errorText } from './io.js';

/**
 * `beluga connect user@host`: the server's Beluga in this computer's browser, through SSH, with no
 * port opened on the server. A join link is minted there (`ssh host beluga web link`), a tunnel
 * opened (`ssh -N -L <free port>:127.0.0.1:7777 host`) and the browser sent to its near end. The
 * tunnel comes back when it drops; Ctrl+C closes it. `host` goes to ssh as typed, so the aliases,
 * users, ports and keys of ~/.ssh/config work as they do for `ssh host`.
 */

/** Where the install script links `beluga` (often not on PATH for a command run over ssh). */
const REMOTE_PATH = 'PATH="$HOME/.local/bin:$PATH"';
const remote = (command: string): string => `sh -c '${REMOTE_PATH} exec beluga ${command}'`;
export const REMOTE_LINK = remote('web link');
export const REMOTE_UP = remote('up');

const INSTALL = 'curl -fsSL https://github.com/kayraucklnc/beluga/releases/latest/download/install.sh | sh';

/** Keeps a dead link from hanging, and has ssh notice a dead network in under a minute. */
const KEEPALIVE = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=20'];

export interface ConnectOptions {
  /** As typed: `user@host`, `host` or an alias from ~/.ssh/config. */
  readonly host: string;
  /** The port on this computer; a free one is picked when it's taken or not given. */
  readonly port?: number;
  /** Open the browser (`--no-open`: only say the link). */
  readonly open: boolean;
}

export interface ConnectDeps {
  /** The ssh program. */
  readonly ssh: string;
  readonly openUrl: (url: string) => void;
  /** Ctrl+C. */
  readonly signal: AbortSignal;
  /** How long to wait before the nth try to bring a dropped tunnel back. */
  readonly backoffMs?: (attempt: number) => number;
}

export interface JoinLink {
  /** Where the web port is, seen from the server (http://127.0.0.1:7777). */
  readonly target: { readonly host: string; readonly port: number };
  /** The part after /join. */
  readonly secret: string;
}

/** The join link in what `beluga web link` printed. */
export function parseJoinLink(text: string): JoinLink | undefined {
  const m = /(https?:\/\/\S+?)\/join#([A-Za-z0-9_-]+)/.exec(text);
  if (!m) return undefined;
  const url = new URL(m[1]!);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return { target: { host, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }, secret: m[2]! };
}

/** The `-L` forward: this computer's loopback to the web port, as the server reaches it. */
export function forwardSpec(local: number, target: JoinLink['target']): string {
  return `127.0.0.1:${local}:${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`;
}

/** What ssh is run with to keep the tunnel open. */
export function tunnelArgs(host: string, local: number, target: JoinLink['target']): string[] {
  return ['-N', '-o', 'ExitOnForwardFailure=yes', ...KEEPALIVE, '-L', forwardSpec(local, target), host];
}

/** A host ssh takes as a host, never as one of its options. */
export function checkHost(host: string): string {
  const h = host.trim();
  if (!h) throw new Error('Which computer? `beluga connect user@host` (or a Host from ~/.ssh/config).');
  if (h.startsWith('-') || /\s/.test(h)) throw new Error(`"${host}" isn't a host to connect to.`);
  return h;
}

interface Ran {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

/** Run one ssh command to its end; prompts (a passphrase, a new host key) go to the terminal, as ssh does. */
function runSsh(ssh: string, args: readonly string[], signal: AbortSignal): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(ssh, [...args], { stdio: ['inherit', 'pipe', 'pipe'], signal });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => void (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => void (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const notRunning = (r: Ran): boolean => /isn[’']t running/.test(r.err + r.out);
const notInstalled = (r: Ran): boolean => r.code === 127 || /beluga: (command )?not found|not found: beluga/i.test(r.err);

/** A join link from the server's Beluga, starting it first when it isn't running. */
export async function mintLink(ssh: string, host: string, signal: AbortSignal): Promise<JoinLink> {
  let ran = await runSsh(ssh, [...KEEPALIVE, host, REMOTE_LINK], signal);
  if (notRunning(ran)) {
    const up = await runSsh(ssh, [...KEEPALIVE, host, REMOTE_UP], signal);
    if (up.code !== 0) throw new Error(`Beluga didn't start on ${host}:\n${(up.err || up.out).trim()}`);
    ran = await runSsh(ssh, [...KEEPALIVE, host, REMOTE_LINK], signal);
  }
  if (notInstalled(ran)) throw new Error(`Beluga isn't installed on ${host}. To put it there, run this on it:\n  ${INSTALL}`);
  const link = parseJoinLink(ran.out);
  if (link) return link;
  if (ran.code === 255) throw new Error(`ssh couldn't reach ${host}:\n${ran.err.trim()}`);
  throw new Error(`No join link from ${host}:\n${(ran.err || ran.out).trim()}`);
}

/** Whether something listens on this port of this computer. */
const listens = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(true));
    socket.once('error', () => resolve(false));
    socket.once('connect', () => socket.destroy());
  });

/** `wanted` if it's free on this computer's loopback, else any free port. */
export function freePort(wanted: number): Promise<number> {
  const tryPort = (port: number): Promise<number | undefined> =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(undefined));
      server.listen(port, '127.0.0.1', () => {
        const got = (server.address() as net.AddressInfo).port;
        server.close(() => resolve(got));
      });
    });
  return tryPort(wanted).then(async (p) => p ?? (await tryPort(0)) ?? Promise.reject(new Error('No free port on this computer')));
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });

const defaultBackoff = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));

/** One run of the tunnel: resolves 'up' once its near end listens, then 'closed' when ssh ends. */
function openTunnel(ssh: string, args: readonly string[], port: number, signal: AbortSignal): { up: Promise<boolean>; closed: Promise<void>; child: ChildProcess } {
  // stdin stays the terminal's: ssh asks for a passphrase there. Its errors show as they are.
  const child = spawn(ssh, [...args], { stdio: ['inherit', 'ignore', 'inherit'] });
  let ended = false;
  const closed = new Promise<void>((resolve) => {
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  }).then(() => void (ended = true));
  const up = (async () => {
    while (!ended && !signal.aborted) {
      if (await listens(port)) return !ended;
      await sleep(150, signal);
    }
    return false;
  })();
  return { up, closed, child };
}

/** Run `beluga connect`: resolves when Ctrl+C closes the tunnel, or when it couldn't open at all. */
export async function connect(opts: ConnectOptions, io: Io, deps: ConnectDeps): Promise<Exit> {
  const { signal } = deps;
  const backoff = deps.backoffMs ?? defaultBackoff;
  let host: string;
  let link: JoinLink;
  try {
    host = checkHost(opts.host);
    io.err(`Asking ${host} for a join link…\n`);
    link = await mintLink(deps.ssh, host, signal);
  } catch (err) {
    if (signal.aborted) return 130;
    io.err(`${errorText(err)}\n`);
    return 1;
  }
  const port = await freePort(opts.port ?? link.target.port);
  const local = `http://127.0.0.1:${port}`;
  const args = tunnelArgs(host, port, link.target);
  let opened = false;
  let attempt = 0;
  while (!signal.aborted) {
    const tunnel = openTunnel(deps.ssh, args, port, signal);
    const kill = (): void => void tunnel.child.kill('SIGTERM');
    signal.addEventListener('abort', kill, { once: true });
    if (await tunnel.up) {
      attempt = 0;
      if (!opened) {
        opened = true;
        const join = `${local}/join#${link.secret}`;
        io.out(`Beluga on ${host} is at ${local}, through SSH. Ctrl+C closes it.\n${opts.open ? 'Opening it in your browser with a join link' : 'Open this link in your browser to let it in'} (once, for 10 minutes):\n\n  ${join}\n\n`);
        if (opts.open) deps.openUrl(join);
      } else {
        io.err(`Connected to ${host} again.\n`);
      }
    }
    await tunnel.closed;
    signal.removeEventListener('abort', kill);
    if (signal.aborted) break;
    if (!opened) {
      io.err(`ssh couldn't open the tunnel to ${host} (is port ${port} free here? \`beluga connect ${host} --port <another>\`).\n`);
      return 1;
    }
    const wait = backoff(attempt++);
    io.err(`The tunnel to ${host} dropped; connecting again in ${Math.round(wait / 1000)} s…\n`);
    await sleep(wait, signal);
  }
  io.err(`Closed the tunnel to ${host}.\n`);
  return 130;
}
