import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCommand } from '../src/cli/args.js';
import { REMOTE_LINK, REMOTE_UP, checkHost, connect, forwardSpec, parseJoinLink, tunnelArgs } from '../src/cli/connect.js';
import type { Io } from '../src/cli/io.js';
import { main } from '../src/cli/main.js';
import { sshWords } from '../src/daemon/web.js';
import { waitFor } from './helpers.js';

/** A terminal the test reads back. */
function capture(): Io & { readonly text: () => string; readonly errors: () => string } {
  let out = '';
  let err = '';
  return { out: (t) => void (out += t), err: (t) => void (err += t), text: () => out, errors: () => err };
}

/**
 * A fake `ssh`: every call is logged; `… beluga web link` prints a join link (or says Beluga isn't
 * running until `… beluga up`); `-N -L near:host:port` forwards TCP like ssh does, and the first such
 * tunnel drops after a moment when `dropFirst`.
 */
function fakeSsh(dir: string, opts: { webPort: number; running?: boolean; dropFirst?: boolean; install?: boolean; refuseTunnel?: boolean }): { bin: string; calls: () => string[][] } {
  const log = path.join(dir, 'calls.log');
  const state = path.join(dir, 'running');
  if (opts.running !== false) writeFileSync(state, '1');
  const bin = path.join(dir, 'ssh');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('fs'), net = require('net');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const last = args[args.length - 1];
if (${opts.install === false} && !args.includes('-N')) { process.stderr.write('sh: 1: exec: beluga: not found\\n'); process.exit(127); }
if (last.includes('web link')) {
  if (!fs.existsSync(${JSON.stringify(state)})) { process.stderr.write('Beluga isn’t running here. \`beluga up\` starts it.\\n'); process.exit(1); }
  process.stdout.write('Open this link in your browser to let it in (once, until 10:00:00):\\n\\n  http://127.0.0.1:${opts.webPort}/join#s3cr3t-Link_42\\n\\n');
  process.exit(0);
}
if (last.endsWith(" up'")) { fs.writeFileSync(${JSON.stringify(state)}, '1'); process.stdout.write('Beluga is running.\\n'); process.exit(0); }
if (args.includes('-N')) {
  if (${opts.refuseTunnel === true}) { process.stderr.write('bind [127.0.0.1]: Address already in use\\n'); process.exit(255); }
  const [, near, host, port] = /^127\\.0\\.0\\.1:(\\d+):(.+):(\\d+)$/.exec(args[args.indexOf('-L') + 1]);
  const tunnels = fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter((l) => l.includes('"-N"')).length;
  const server = net.createServer((c) => { const far = net.connect(Number(port), host); c.pipe(far).pipe(c); far.on('error', () => c.destroy()); c.on('error', () => far.destroy()); });
  server.listen(Number(near), '127.0.0.1');
  const quit = () => { server.close(); process.exit(0); };
  process.on('SIGTERM', quit);
  if (${opts.dropFirst === true} && tunnels === 1) setTimeout(() => { process.stderr.write('client_loop: send disconnect: Broken pipe\\n'); quit(); }, 400);
  setInterval(() => {}, 1000);
} else process.exit(255);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []) };
}

let dir: string;
let ui: Server;
let webPort: number;
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-connect-'));
  // The server's web port, here: the tunnel's far end.
  ui = createServer((_req, res) => res.end('beluga ui'));
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve));
  webPort = (ui.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise((resolve) => ui.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const fetchText = async (url: string): Promise<string> => (await fetch(url)).text();

describe('beluga connect (BLG-657)', () => {
  it('opens the UI in one command through an ~/.ssh/config alias, comes back when the tunnel drops, and Ctrl+C closes it', async () => {
    const ssh = fakeSsh(dir, { webPort, running: false, dropFirst: true });
    const io = capture();
    const ctrlC = new AbortController();
    const opened: string[] = [];
    const done = connect({ host: 'mybox', open: true }, io, { ssh: ssh.bin, openUrl: (u) => void opened.push(u), signal: ctrlC.signal, backoffMs: () => 50 });

    await waitFor(() => opened.length === 1, 15_000);
    const join = new URL(opened[0]!);
    expect(join.hash).toBe('#s3cr3t-Link_42');
    expect(join.hostname).toBe('127.0.0.1');
    // The server's port is taken here (by this test's stand-in for it), so another one was picked.
    expect(Number(join.port)).not.toBe(webPort);
    expect(io.text()).toContain(`Beluga on mybox is at ${join.origin}, through SSH. Ctrl+C closes it.`);
    expect(await fetchText(`${join.origin}/`)).toBe('beluga ui');

    await waitFor(() => io.errors().includes('Connected to mybox again.'), 15_000);
    expect(io.errors()).toContain('The tunnel to mybox dropped; connecting again');
    expect(await fetchText(`${join.origin}/`)).toBe('beluga ui');
    expect(opened).toHaveLength(1);

    ctrlC.abort();
    expect(await done).toBe(130);
    expect(io.errors()).toContain('Closed the tunnel to mybox.');
    await expect(fetch(`${join.origin}/`)).rejects.toThrow();

    // The alias goes to ssh as typed, so ~/.ssh/config's user, port, key and jump host apply.
    const calls = ssh.calls();
    const remote = calls.filter((c) => !c.includes('-N'));
    expect(remote.map((c) => c.slice(-2))).toEqual([
      ['mybox', REMOTE_LINK],
      ['mybox', REMOTE_UP],
      ['mybox', REMOTE_LINK],
    ]);
    const tunnels = calls.filter((c) => c.includes('-N'));
    expect(tunnels).toHaveLength(2);
    expect(tunnels[0]).toEqual(tunnelArgs('mybox', Number(join.port), { host: '127.0.0.1', port: webPort }));
    expect(tunnels[0]).toContain('ExitOnForwardFailure=yes');
  }, 40_000);

  it('keeps the port asked for, and only says the link with --no-open', async () => {
    const ssh = fakeSsh(dir, { webPort });
    const io = capture();
    const ctrlC = new AbortController();
    const opened: string[] = [];
    const free = createServer();
    await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
    const port = (free.address() as AddressInfo).port;
    await new Promise((resolve) => free.close(resolve));
    const done = connect({ host: 'kay@box.example', port, open: false }, io, { ssh: ssh.bin, openUrl: (u) => void opened.push(u), signal: ctrlC.signal });
    await waitFor(() => io.text().includes('/join#'), 15_000);
    expect(io.text()).toContain(`http://127.0.0.1:${port}/join#s3cr3t-Link_42`);
    expect(io.text()).toContain('Open this link in your browser');
    expect(opened).toEqual([]);
    ctrlC.abort();
    expect(await done).toBe(130);
  }, 30_000);

  it('says how to install Beluga when the server has none', async () => {
    const ssh = fakeSsh(dir, { webPort, install: false });
    const io = capture();
    expect(await connect({ host: 'box', open: true }, io, { ssh: ssh.bin, openUrl: () => undefined, signal: new AbortController().signal })).toBe(1);
    expect(io.errors()).toContain("Beluga isn't installed on box.");
    expect(io.errors()).toContain('install.sh | sh');
  });

  it('gives up, saying why, when the tunnel never opens', async () => {
    const ssh = fakeSsh(dir, { webPort, refuseTunnel: true });
    const io = capture();
    expect(await connect({ host: 'box', open: true }, io, { ssh: ssh.bin, openUrl: () => undefined, signal: new AbortController().signal })).toBe(1);
    expect(io.errors()).toContain("ssh couldn't open the tunnel to box");
  });

  it('reads the join link, builds the forward, and never takes a host for an ssh option', () => {
    expect(parseJoinLink('Open this…\n\n  http://127.0.0.1:7777/join#abc_D-9\n')).toEqual({ target: { host: '127.0.0.1', port: 7777 }, secret: 'abc_D-9' });
    expect(parseJoinLink('  http://[::1]:7790/join#x')).toEqual({ target: { host: '::1', port: 7790 }, secret: 'x' });
    expect(parseJoinLink('Beluga isn’t running here.')).toBeUndefined();
    expect(forwardSpec(7777, { host: '127.0.0.1', port: 7777 })).toBe('127.0.0.1:7777:127.0.0.1:7777');
    expect(forwardSpec(8000, { host: '::1', port: 7790 })).toBe('127.0.0.1:8000:[::1]:7790');
    expect(checkHost(' kay@box ')).toBe('kay@box');
    expect(() => checkHost('-oProxyCommand=touch /tmp/x')).toThrow("isn't a host");
    expect(() => checkHost('box; rm')).toThrow("isn't a host");
    expect(() => checkHost('')).toThrow('Which computer?');
  });

  it('is typed as `beluga connect <host> [--port] [--no-open]`', async () => {
    expect(parseCommand(['connect', 'kay@box', '--port', '7800', '--no-open'])).toEqual({ name: 'connect', flags: { port: '7800', 'no-open': true }, positionals: ['kay@box'] });
    const io = capture();
    expect(await main(['connect'], io)).toBe(2);
    expect(io.errors()).toContain('`beluga connect` takes one host');
    expect(await main(['connect', 'box', '--port', '99999'], io)).toBe(2);
  });
});

describe('the copy-paste line on the server (BLG-657)', () => {
  it('`beluga web` says the ssh line for a loopback web port, and nothing for another address', () => {
    const words = sshWords('http://127.0.0.1:7777', 'kay@box');
    expect(words).toContain('beluga connect kay@box');
    expect(words).toContain('ssh -N -L 7777:127.0.0.1:7777 kay@box');
    expect(sshWords('http://[::1]:7790', 'kay@box')).toContain('ssh -N -L 7790:[::1]:7790 kay@box');
    expect(sshWords('http://100.101.102.103:7777', 'kay@box')).toBe('');
  });

  it('`beluga web link` with no Beluga running says so, instead of running one in that ssh session', async () => {
    const io = capture();
    expect(await main(['web', 'link'], io)).toBe(1);
    expect(io.errors()).toContain('Beluga isn’t running here. `beluga up` starts it.');
  });
});
