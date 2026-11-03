import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, HELP_WIDTH, UsageError, countFlag, helpText, parseCommand, wrap } from '../src/cli/args.js';
import type { Io } from '../src/cli/io.js';
import { lastLines, logs } from '../src/cli/logs.js';
import { daemonArgs } from '../src/cli/daemon.js';
import { main } from '../src/cli/main.js';
import { tilde } from '../src/cli/paths.js';
import { type StatusReport, describe as describeStatus, relayWords, report, status, webWords } from '../src/cli/status.js';
import { builtUi } from './web-helpers.js';
import { stop } from '../src/cli/stop.js';
import { up } from '../src/cli/up.js';
import { parseConfig } from '../src/config.js';
import { clearDaemonInfo, releaseLock } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { waitFor } from './helpers.js';

/** A terminal the test reads back. */
function capture(): Io & { readonly text: () => string; readonly errors: () => string } {
  let out = '';
  let err = '';
  return { out: (t) => void (out += t), err: (t) => void (err += t), text: () => out, errors: () => err };
}

const running: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
  clearDaemonInfo();
  releaseLock();
});

/** The daemon `beluga up` would start, here in the test's process. */
const startHere = async (): Promise<RunningDaemon> => {
  const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '9.9.9', keepAlive: true });
  running.push(d);
  return d;
};

const never = new Promise<string>(() => undefined);
const noForeground = async (): Promise<void> => {
  throw new Error('not in this test');
};

describe('reading what was typed', () => {
  it('knows each command and its flags', () => {
    expect(parseCommand([])).toEqual({ name: 'help', flags: {}, positionals: [] });
    expect(parseCommand(['up', '--foreground'])).toMatchObject({ name: 'up', flags: { foreground: true } });
    expect(parseCommand(['start', '-f'])).toMatchObject({ name: 'up', flags: { foreground: true } });
    expect(parseCommand(['status', '--json'])).toMatchObject({ name: 'status', flags: { json: true } });
    expect(parseCommand(['logs', '-f', '-n', '20'])).toMatchObject({ name: 'logs', flags: { follow: true, lines: '20' } });
    expect(parseCommand(['--version']).name).toBe('version');
    expect(parseCommand(['-h']).name).toBe('help');
    expect(parseCommand(['stop', '--help'])).toEqual({ name: 'help', flags: {}, positionals: ['stop'] });
  });

  it("hands the daemon's own flags through untouched", () => {
    expect(parseCommand(['daemon', '--keep-alive', 'demo'])).toEqual({ name: 'daemon', flags: {}, positionals: ['--keep-alive', 'demo'] });
    expect(parseCommand(['mcp-serve', 'board'])).toMatchObject({ name: 'mcp-serve', positionals: ['board'] });
  });

  it('says plainly what was typed wrong, and for which command', () => {
    expect(() => parseCommand(['launch'])).toThrow(/no `beluga launch`/);
    expect(() => parseCommand(['up', '--fast'])).toThrow(UsageError);
    try {
      parseCommand(['status', '--nope']);
    } catch (err) {
      expect((err as UsageError).command).toBe('status');
    }
    expect(() => countFlag('lots', 'lines', 50, 'logs')).toThrow(/whole number/);
    expect(countFlag(undefined, 'lines', 50, 'logs')).toBe(50);
    expect(countFlag('0', 'lines', 50, 'logs')).toBe(0);
  });

  it("lists people's commands, not the Mac app's", () => {
    const help = helpText();
    for (const c of ['setup', 'up', 'status', 'stop', 'logs', 'project', 'pair']) expect(help).toMatch(new RegExp(`^  ${c} +\\S`, 'm'));
    expect(help).not.toContain('mcp-serve');
    expect(help).not.toContain('daemon');
    expect(helpText('logs')).toMatch(/^Usage:\n {2}beluga logs \[-f\]/);
  });

  it('fits every help and usage line in 80 columns (BLG-677)', async () => {
    const widest = (text: string): number => Math.max(...text.split('\n').map((l) => [...l].length));
    expect(widest(helpText())).toBeLessThanOrEqual(HELP_WIDTH);
    for (const [name, spec] of Object.entries(COMMANDS)) {
      expect({ name, width: widest(helpText(name)) <= HELP_WIDTH }).toEqual({ name, width: true });
      // The Mac app's own commands take --help as theirs: never run here.
      if ('passThrough' in spec) continue;
      const io = capture();
      await main([name, '--help'], io);
      expect(widest(io.text() + io.errors())).toBeLessThanOrEqual(HELP_WIDTH);
    }
    const wrong = capture();
    await main(['project', '--nope'], wrong);
    expect(widest(wrong.errors())).toBeLessThanOrEqual(HELP_WIDTH);
    expect(wrong.errors()).toContain('  beluga project remove <name>');
    expect(wrap('a b c d e f', 5, '  ')).toEqual(['a b c', '  d e', '  f']);
  });

  it('`beluga daemon` still takes the web port’s options (BLG-680)', () => {
    expect(daemonArgs(['--keep-alive', 'demo'])).toEqual({ rest: ['demo'], keepAlive: true });
    expect(daemonArgs(['--keep-alive', '--listen', '127.0.0.1:7790', '--allow-host', 'box.tail.ts.net', 'demo'])).toEqual({ rest: ['demo'], keepAlive: true, web: { host: '127.0.0.1', port: 7790, allowedHosts: ['box.tail.ts.net'] } });
    expect(daemonArgs(['--insecure-http', '--listen=0.0.0.0:7777']).web).toMatchObject({ host: '0.0.0.0', insecureHttp: true });
  });

  it('answers a mistake with exit 2 and where to look', async () => {
    const io = capture();
    expect(await main(['nope'], io)).toBe(2);
    expect(io.errors()).toContain('`beluga help`');
    const usage = capture();
    expect(await main(['logs', '-n', 'x'], usage)).toBe(2);
    expect(usage.errors()).toContain('Usage:\n  beluga logs');
    const version = capture();
    expect(await main(['version'], version)).toBe(0);
    expect(version.text()).toMatch(/^Beluga \d/);
  });
});

describe('beluga up', () => {
  it('starts Beluga in the background and says where it listens', async () => {
    let d: RunningDaemon | undefined;
    const io = capture();
    expect(await up({}, io, { start: async () => ((d = await startHere()), never), foreground: noForeground })).toBe(0);
    expect(io.text()).toContain(`127.0.0.1:${d!.port}`);
    expect(io.text()).toContain('beluga status');
    const again = capture();
    expect(await up({}, again, { start: () => Promise.reject(new Error('started twice')), foreground: noForeground })).toBe(0);
    expect(again.text()).toMatch(/already running on 127\.0\.0\.1:\d+.*started \d+ seconds? ago/);
  });

  it("won't start a second one in the foreground", async () => {
    await startHere();
    const io = capture();
    expect(await up({ foreground: true }, io, { start: () => never, foreground: noForeground })).toBe(1);
    expect(io.errors()).toContain('beluga stop');
  });

  it('runs in this process with --foreground', async () => {
    let ran = false;
    const io = capture();
    expect(await up({ foreground: true }, io, { start: () => never, foreground: async () => void (ran = true) })).toBe(0);
    expect(ran).toBe(true);
    expect(io.errors()).toContain('Ctrl+C');
  });

  it('says why when it stops while starting, and points at the log', async () => {
    const io = capture();
    expect(await up({}, io, { start: async () => 'exited with code 1', foreground: noForeground })).toBe(1);
    expect(io.errors()).toContain('stopped while starting (exited with code 1)');
    expect(io.errors()).toContain('beluga logs');
    const slow = capture();
    expect(await up({}, slow, { start: () => never, foreground: noForeground, waitMs: 200 })).toBe(1);
    expect(slow.errors()).toContain("didn't start within");
  });
});

describe('beluga status', () => {
  it('says it is not running, with how to start it', async () => {
    const io = capture();
    expect(await status({}, io)).toBe(1);
    expect(io.text()).toContain('beluga up');
    const json = capture();
    await status({ json: true }, json);
    expect(JSON.parse(json.text())).toMatchObject({ running: false, projects: [], phones: [] });
  });

  it('reports the running daemon: version, projects, phones, browser access', async () => {
    const d = await startHere();
    const io = capture();
    expect(await status({}, io)).toBe(0);
    expect(io.text()).toContain(`Beluga 9.9.9 is running (pid ${process.pid}`);
    expect(io.text()).toContain(`127.0.0.1:${d.port}`);
    expect(io.text()).toContain('Projects: none yet. Add one with `beluga project add');
    expect(io.text()).toContain('Phones: none paired. Pair one with `beluga pair`');
    expect(io.text()).toContain('Browser access: off');
    const json = capture();
    await status({ json: true }, json);
    expect(JSON.parse(json.text())).toMatchObject({ running: true, version: '9.9.9', port: d.port, keptAlive: true, web: { on: false, sessions: 0 } });
    // It detached again: only the daemon's own count is left.
    await waitFor(() => d.server.clients.size === 0);
  });

  it('says the relay starts with the first phone, not that it is off (BLG-677)', () => {
    expect(relayWords({ relay: 'off', phones: [] })).toBe('starts when a phone is paired');
    expect(relayWords({ phones: [] })).toBe('starts when a phone is paired');
    const phone = [{ name: 'Pixel', platform: 'android', linked: true }];
    expect(relayWords({ relay: 'starting', phones: phone })).toBe('starting');
    expect(relayWords({ relay: 'ready', phones: phone })).toMatch(/^ready/);
    expect(relayWords({ relay: 'off', phones: phone })).toMatch(/not running.*beluga logs/);
    const info = { pid: 2, port: 4000, token: 'x'.repeat(32), version: '1', ipc: 1, room: 'r', roomKey: 'host', startedAt: 1 };
    const direct = report(info, { projects: [], companion: { devices: [] }, prefs: { tunnel: 'p2p' } });
    expect(relayWords(direct)).toMatch(/direct connections only/);
    expect(describeStatus({ ...report(info, { projects: [], companion: { devices: [], relay: 'off' } }) })).toContain('Phone relay: starts when a phone is paired');
  });

  it('shows the real browser access: the web port, its address and the browsers let in (BLG-680)', async () => {
    const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '9.9.9', keepAlive: true, web: { port: 0, root: builtUi() } });
    running.push(d);
    const sessions = d.web.sessions;
    sessions.redeem(new URL(sessions.link(d.webUrl!).url).hash.replace(/^#/, ''), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15');
    const io = capture();
    expect(await status({}, io)).toBe(0);
    expect(io.text()).toContain(`Browser access: on, at ${d.webUrl} (1 browser let in). \`beluga web\` gives a link.`);
    const json = capture();
    await status({ json: true }, json);
    expect(JSON.parse(json.text()).web).toEqual({ on: true, url: d.webUrl, sessions: 1 });
    expect(webWords({ on: false, sessions: 0 })).toContain('`beluga web` opens it');
    expect(webWords({ on: true, url: 'http://127.0.0.1:7777', sessions: 0 })).toContain('no browser let in yet');
  });

  it('`beluga web` asks the running Beluga for a link, and `web stop` closes its port', async () => {
    const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '9.9.9', keepAlive: true, web: { port: 0, root: builtUi() } });
    running.push(d);
    const io = capture();
    expect(await main(['web'], io)).toBe(0);
    expect(io.text()).toContain(`${d.webUrl}/join#`);
    const list = capture();
    expect(await main(['web', 'sessions'], list)).toBe(0);
    expect(list.text()).toMatch(/No browsers are let in|Safari on macOS {2,}joined/);
    const wrong = capture();
    expect(await main(['web', 'revoke'], wrong)).toBe(1);
    expect(wrong.errors()).toContain('Which browser?');
    const help = capture();
    expect(await main(['web', '--help'], help)).toBe(0);
    expect(help.text()).toContain('beluga web revoke <id or name>');
    expect(await main(['web', 'stop'], capture())).toBe(0);
    expect(d.web.on).toBe(false);
  });

  it('lists projects and phones in plain words', () => {
    const now = 10_000_000;
    const r: StatusReport = {
      running: true,
      version: '2.1.0',
      pid: 42,
      port: 4000,
      startedAt: now - 3 * 3600_000,
      keptAlive: false,
      projects: [{ name: 'beluga', root: path.join(os.homedir(), 'beluga') }, { name: 'site', root: '/srv/site', problem: 'not a git repository' }],
      phones: [{ name: 'Pixel', platform: 'android', linked: true }, { name: 'iPhone', platform: 'ios', linked: false, lastSeen: now - 2 * 86_400_000 }],
      relay: 'ready',
      web: { on: false, sessions: 0 },
    };
    const text = describeStatus(r, now);
    expect(text).toContain('Beluga 2.1.0 is running (pid 42, up 3 hours)');
    expect(text).toContain('stops when the last window closes');
    expect(text).toContain(`beluga  ${path.join('~', 'beluga')}`);
    expect(text).toContain("/srv/site  (can't open: not a git repository)");
    expect(text).toContain('Pixel (android), linked now');
    expect(text).toContain('iPhone (ios), last seen 2 days ago');
    expect(text).toContain('Phone relay: ready');
  });
});

describe('beluga stop', () => {
  it('stops the running daemon the way a window would', async () => {
    const d = await startHere();
    const io = capture();
    expect(await stop(io)).toBe(0);
    await d.done;
    expect(io.text()).toContain('Beluga stopped');
  });

  it('is calm when nothing is running', async () => {
    const io = capture();
    expect(await stop(io)).toBe(0);
    expect(io.text()).toContain("isn't running");
  });
});

describe('beluga logs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-cli-logs-'));
  afterEach(() => rmSync(path.join(dir, 'daemon.log'), { force: true }));
  const file = path.join(dir, 'daemon.log');

  it('shows the last lines', async () => {
    expect(lastLines('a\nb\nc\n', 2)).toBe('b\nc\n');
    expect(lastLines('a\nb', 5)).toBe('a\nb\n');
    expect(lastLines('', 5)).toBe('');
    expect(lastLines('a\n', 0)).toBe('');
    writeFileSync(file, Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const io = capture();
    expect(await logs({ follow: false, lines: 3, file }, io)).toBe(0);
    expect(io.text()).toBe('line 77\nline 78\nline 79\n');
  });

  it('says there is no log yet, with how to get one', async () => {
    const io = capture();
    expect(await logs({ follow: false, lines: 10, file }, io)).toBe(1);
    expect(io.errors()).toContain('beluga up');
  });

  it('follows new lines, whole ones only, across a fresh start, until Ctrl+C', async () => {
    writeFileSync(file, 'old\n');
    const io = capture();
    const ctrlC = new AbortController();
    const following = logs({ follow: true, lines: 10, file, signal: ctrlC.signal }, io);
    appendFileSync(file, 'one\ntw');
    await waitFor(() => io.text().includes('one\n'));
    expect(io.text()).toBe('old\none\n');
    appendFileSync(file, 'o\n');
    await waitFor(() => io.text().endsWith('two\n'));
    // Grown past 5 MB and set aside: the new log is read from its start.
    writeFileSync(file, 'fresh\n');
    await waitFor(() => io.text().endsWith('fresh\n'));
    ctrlC.abort();
    expect(await following).toBe(0);
  });

  it('waits for a log that is not there yet when following', async () => {
    const io = capture();
    const ctrlC = new AbortController();
    const following = logs({ follow: true, lines: 10, file, signal: ctrlC.signal }, io);
    expect(io.errors()).toContain('waiting');
    writeFileSync(file, 'started\n');
    await waitFor(() => io.text() === 'started\n');
    ctrlC.abort();
    expect(await following).toBe(0);
  });
});

describe('paths', () => {
  it('writes the home folder as ~', () => {
    const home = path.join(os.tmpdir(), 'kay');
    expect(tilde(path.join(home, 'projects', 'x'), home)).toBe(path.join('~', 'projects', 'x'));
    expect(tilde(home, home)).toBe('~');
    expect(tilde(`${home}ra`, home)).toBe(`${home}ra`);
  });
});
