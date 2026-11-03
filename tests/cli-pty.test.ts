import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import DHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { saveClaudeToken } from '../src/cli/claude.js';
import { pairDevice } from '../src/companion/client.js';
import { deviceKeys, newSeed } from '../src/companion/device-crypto.js';
import { parseConfig } from '../src/config.js';
import { saveSettings } from '../src/core/settings.js';
import { clearDaemonInfo, releaseLock } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { waitFor } from './helpers.js';

/**
 * `beluga pair` and `beluga setup` in a real terminal (BLG-681): a pty, as over ssh -tt, against a
 * daemon whose phone side is on a local testnet, with a phone that types the code it shows. The
 * other tests ask with a scripted function and can't see what a terminal does.
 */

type Pty = { readonly _pty?: string; onData(fn: (d: string) => void): void; onExit(fn: (e: { exitCode: number }) => void): void; write(d: string): void; kill(): void };
const ptyModule = createRequire(import.meta.url)('@lydell/node-pty') as { spawn(file: string, args: string[], opts: object): Pty };

const ROOT = path.resolve(import.meta.dirname, '..');
let testnet: Testnet;
const cleanup: Array<() => Promise<void> | void> = [];
let daemon: RunningDaemon | undefined;

beforeAll(async () => {
  testnet = await createTestnet(3);
  process.env.BELUGA_DHT_BOOTSTRAP = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => `${b.host}:${b.port}`).join(',');
  // No relay tunnel (it would fetch cloudflared): phones come directly, on the testnet.
  saveSettings({ tunnel: 'p2p', computerName: 'homelab' });
  writeFileSync(path.join(process.env.BELUGA_HOME!, 'projects.json'), JSON.stringify({ roots: [] }));
}, 30_000);
afterAll(async () => {
  delete process.env.BELUGA_DHT_BOOTSTRAP;
  await testnet.destroy();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  await daemon?.stop();
  daemon = undefined;
  clearDaemonInfo();
  releaseLock();
});

const startHere = async (): Promise<RunningDaemon> => {
  // Each test pairs its own phone: none kept from the one before.
  rmSync(path.join(process.env.BELUGA_HOME!, 'devices.json'), { force: true });
  daemon = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true });
  return daemon;
};

/**
 * The `beluga` command in a pty; then `stty -a`, to see the terminal it leaves behind. Ctrl+C
 * reaches the wrapping shell too: `trap : INT` keeps it alive to pass on beluga's code, where
 * dash (Linux's /bin/sh) would die of the signal and the pty would say 0. The command still gets
 * SIGINT as usual (a trap with a command isn't inherited, unlike an ignored signal).
 */
function terminal(...args: string[]): { text: () => string; type: (s: string) => void; exited: Promise<number>; mode: () => string } {
  let out = '';
  const cli = [process.execPath, '--import', 'tsx', path.join(ROOT, 'src/cli.ts'), ...args].map((a) => `'${a}'`).join(' ');
  const pty = ptyModule.spawn('/bin/sh', ['-c', `trap : INT; ${cli}; code=$?; echo; echo "STTY: $(stty -a | tr '\\n' ' ')"; exit $code`], { name: 'xterm-256color', cols: 100, rows: 50, cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0' } });
  pty.onData((d) => void (out += d));
  const exited = new Promise<number>((r) => pty.onExit((e) => r(e.exitCode)));
  cleanup.push(() => pty.kill());
  // The terminal's settings now, from outside (stty on its device), while the command runs.
  const mode = (): string => execFileSync('stty', [process.platform === 'darwin' ? '-f' : '-F', pty._pty!, '-a'], { encoding: 'utf8' }).replace(/\n/g, ' ');
  return { text: () => out.replace(/\x1b\[[\d;?]*[A-Za-z]/g, ''), type: (s) => pty.write(s), exited, mode };
}

function phone() {
  const node = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
  cleanup.push(() => node.destroy({ force: true }));
  return { node, device: { keys: deviceKeys(newSeed()), name: 'Pixel 9', platform: 'android' as const, app: '1.1.0' } };
}

/** The phone types the code the terminal shows, then the person types y at Pair?. */
async function pairThrough(term: ReturnType<typeof terminal>) {
  try {
    return await pairing(term);
  } catch (err) {
    throw new Error(`${String(err)}\n--- the terminal said:\n${term.text().split('\n').filter((l) => !/[█▀▄]/.test(l)).join('\n')}`);
  }
}

async function pairing(term: ReturnType<typeof terminal>) {
  const code = (await waitFor(() => /type this code on the phone: ([0-9A-Z-]{14})/.exec(term.text()), 20_000))[1]!;
  const p = phone();
  const paired = pairDevice(p.node, code, p.device, { timeoutMs: 60_000 }).catch((err: Error) => err);
  await waitFor(() => term.text().includes('Pair? [y/N]'), 30_000);
  // While it asks, the terminal is as the person left it: lines, echo, Ctrl+C a signal. readline's
  // raw mode (a tcsetattr that waits for the terminal to take all output, then blocking redraws)
  // held the whole command when the terminal was slow to read, over ssh -tt (BLG-681).
  await new Promise((r) => setTimeout(r, 300));
  normalMode(`STTY: ${term.mode()}`);
  // Some time at the prompt, as a person takes: the countdown and the link go on meanwhile.
  await new Promise((r) => setTimeout(r, 1500));
  term.type('y\r');
  await waitFor(() => term.text().includes('Paired with Pixel 9'), 20_000);
  return paired;
}

function normalMode(text: string): void {
  const stty = /STTY: (.*)/.exec(text)?.[1] ?? '';
  expect(stty).toMatch(/(^|\s)icanon(\s|$)/);
  expect(stty).toMatch(/(^|\s)echo(\s|$)/);
  expect(stty).toMatch(/(^|\s)isig(\s|$)/);
}

describe.skipIf(process.platform === 'win32')('in a real terminal', () => {
  it('`beluga pair`: y at Pair? pairs, and the terminal is left as it was', async () => {
    await startHere();
    const term = terminal('pair');
    const paired = await pairThrough(term);
    expect(await term.exited).toBe(0);
    expect(await paired).not.toBeInstanceOf(Error);
    normalMode(term.text());
  }, 90_000);

  it('`beluga pair`: Ctrl+C at Pair? cancels cleanly', async () => {
    const d = await startHere();
    const term = terminal('pair');
    const code = (await waitFor(() => /type this code on the phone: ([0-9A-Z-]{14})/.exec(term.text()), 20_000))[1]!;
    const p = phone();
    const paired = pairDevice(p.node, code, p.device, { timeoutMs: 60_000 }).catch((err: Error) => err);
    await waitFor(() => term.text().includes('Pair? [y/N]'), 30_000);
    term.type('\x03');
    expect(await term.exited).toBe(130);
    expect(term.text()).toContain('Pairing cancelled');
    expect(await paired).toBeInstanceOf(Error);
    expect(d.core.session.store.getState().companion.pairing).toBeUndefined();
    normalMode(term.text());
  }, 90_000);

  it('`beluga setup`: the phone step pairs with y in the same terminal', async () => {
    await startHere();
    saveClaudeToken(`sk-ant-oat01-${'Q'.repeat(90)}`);
    const term = terminal('setup');
    await waitFor(() => term.text().includes('A first project'), 30_000);
    term.type('\r');
    const paired = await pairThrough(term);
    await waitFor(() => term.text().includes('Keep Beluga running'), 20_000);
    term.type('n\r');
    expect(await term.exited).toBe(0);
    expect(await paired).not.toBeInstanceOf(Error);
    normalMode(term.text());
  }, 120_000);

  it('`beluga setup`: Ctrl+C at Pair? stops setup, closes the pairing, leaves the terminal as it was', async () => {
    const d = await startHere();
    saveClaudeToken(`sk-ant-oat01-${'Q'.repeat(90)}`);
    const term = terminal('setup');
    await waitFor(() => term.text().includes('A first project'), 30_000);
    term.type('\r');
    const code = (await waitFor(() => /type this code on the phone: ([0-9A-Z-]{14})/.exec(term.text()), 20_000))[1]!;
    const p = phone();
    const paired = pairDevice(p.node, code, p.device, { timeoutMs: 60_000 }).catch((err: Error) => err);
    await waitFor(() => term.text().includes('Pair? [y/N]'), 30_000);
    term.type('\x03');
    expect(await term.exited).toBe(130);
    expect(term.text()).toContain('Setup stopped');
    expect(term.text()).not.toContain('Keep Beluga running');
    expect(await paired).toBeInstanceOf(Error);
    expect(d.core.session.store.getState().companion.pairing).toBeUndefined();
    normalMode(term.text());
  }, 120_000);
});
