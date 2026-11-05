import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { webWords } from '../src/cli/status.js';
import { TailscaleReach, readSelf, serveProblem, tailscaleWords } from '../src/daemon/reach/tailscale.js';
import { WebAccess, readWebConfig, webConfigPath } from '../src/daemon/web-access.js';
import { splitWebArgs } from '../src/daemon/web.js';
import { webSessionsPath } from '../src/daemon/web-sessions.js';
import { type Reply, builtUi } from './web-helpers.js';

const NAME = 'box.tail1234.ts.net';
const OWN = 'kay@example.com';

type Mode = 'running' | 'needs-login' | 'tagged' | 'denied' | 'no-https';

/** The fake is a `#!node` script: Windows can't start one (its real tailscale is an .exe), so the tests that run it are for macOS and Linux. */
const WINDOWS = process.platform === 'win32';

/** A fake `tailscale`: `status --json` as the real one says it, `serve` that works or says why not, every call logged. */
function fakeTailscale(dir: string, mode: Mode = 'running'): { bin: string; calls: () => string[][] } {
  const log = path.join(dir, 'calls.log');
  const status = {
    BackendState: mode === 'needs-login' ? 'NeedsLogin' : 'Running',
    Self: { DNSName: `${NAME}.`, UserID: mode === 'tagged' ? 2 : 1 },
    User: { 1: { LoginName: OWN }, 2: { LoginName: 'tagged-devices' } },
  };
  const bin = path.join(dir, 'tailscale');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'status') { process.stdout.write(${JSON.stringify(JSON.stringify(status))}); process.exit(0); }
if (args[0] === 'serve' && args.includes('off')) process.exit(0);
if (args[0] === 'serve') {
  if (${JSON.stringify(mode)} === 'denied') { process.stderr.write('Access denied: serve config denied\\nUse \\'sudo tailscale serve\\' or set an operator.\\n'); process.exit(1); }
  if (${JSON.stringify(mode)} === 'no-https') { process.stderr.write('HTTPS is not enabled for your tailnet\\n'); process.exit(1); }
  process.stdout.write('Available within your tailnet:\\n\\nhttps://${NAME}/\\n|-- proxy http://127.0.0.1:7777\\n');
  process.exit(0);
}
process.exit(2);
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []) };
}

/** A request as tailscaled hands it over: from loopback, under the ts.net name, saying who asks. */
function via(port: number, method: string, urlPath: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const asLogin = (login: string): Record<string, string> => ({ host: NAME, 'tailscale-user-login': login, 'x-forwarded-proto': 'https', accept: 'text/html' });

let dir: string;
const accesses: WebAccess[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-ts-'));
});
afterEach(async () => {
  for (const w of accesses.splice(0)) await w.close();
  rmSync(webSessionsPath(), { force: true });
  rmSync(webConfigPath(), { force: true });
  rmSync(dir, { recursive: true, force: true });
});

async function tailnetAccess(mode: Mode = 'running', remember = false): Promise<{ web: WebAccess; port: number; ts: ReturnType<typeof fakeTailscale>; adopted: WebSocket[] }> {
  const ts = fakeTailscale(dir, mode);
  const adopted: WebSocket[] = [];
  const web = new WebAccess({ door: { adopt: (ws) => void adopted.push(ws) }, root: builtUi(), remember, tailscaleReach: { bin: ts.bin } });
  accesses.push(web);
  await web.start({ port: 0 });
  return { web, port: Number(new URL(web.status().url!).port), ts, adopted };
}

describe('beluga web --tailscale (BLG-656)', () => {
  it.skipIf(WINDOWS)('serves the web port on the tailnet (Serve, never Funnel) and says its https address, with a QR', async () => {
    const { web, port, ts } = await tailnetAccess();
    const t = await web.goTailscale();
    expect(t.url).toBe(`https://${NAME}`);
    expect(t.login).toBe(OWN);
    expect(t.link.url).toMatch(new RegExp(`^https://${NAME.replace(/\./g, '\\.')}/join#`));
    expect(ts.calls()).toEqual([
      ['status', '--json'],
      ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`],
    ]);
    expect(ts.calls().flat()).not.toContain('funnel');
    const words = tailscaleWords(t, ['QRLINE']);
    expect(words).toContain(`Beluga is on your tailnet at https://${NAME}`);
    expect(words).toContain(`Your own Tailscale login (${OWN}) gets in without a link`);
    expect(words).toContain('  QRLINE');
    expect(words).toContain(t.link.url);
    expect(words).toContain('never Funnel');
  });

  it.skipIf(WINDOWS)('lets your own login in without a link; another tailnet user needs one', async () => {
    const { web, port, adopted } = await tailnetAccess();
    const t = await web.goTailscale();

    const own = await via(port, 'GET', '/', asLogin(OWN));
    expect(own.status).toBe(200);
    expect(own.body.toString()).toContain('<title>Beluga</title>');
    // And its socket: Serve's own origin, your login.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: NAME, origin: `https://${NAME}`, 'tailscale-user-login': OWN } });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    expect(adopted).toHaveLength(1);
    ws.close();

    const other = await via(port, 'GET', '/', asLogin('mia@example.com'));
    expect(other.status).toBe(401);
    expect(other.body.toString()).toContain('Ask for a link to open Beluga');
    const joined = await via(port, 'POST', '/join', { ...asLogin('mia@example.com'), origin: `https://${NAME}`, 'content-type': 'application/json' }, JSON.stringify({ secret: t.link.url.split('#')[1] }));
    expect(joined.status).toBe(200);
    const cookie = String(joined.headers['set-cookie']?.[0]).split(';')[0]!;
    expect((await via(port, 'GET', '/', { ...asLogin('mia@example.com'), cookie })).status).toBe(200);
  });

  it.skipIf(WINDOWS)('believes the login header only from tailscaled, under the ts.net name, while Serve is on', async () => {
    const { web, port } = await tailnetAccess();
    // Before Serve: the name isn't even answered to.
    expect((await via(port, 'GET', '/', asLogin(OWN))).status).toBe(421);
    await web.goTailscale();
    // Under the loopback name (a local program, not Serve): the header counts for nothing.
    expect((await via(port, 'GET', '/', { ...asLogin(OWN), host: `127.0.0.1:${port}` })).status).toBe(401);
    // Case doesn't matter in a login, but it has to be yours.
    expect((await via(port, 'GET', '/', asLogin(OWN.toUpperCase()))).status).toBe(200);
    expect((await via(port, 'GET', '/', asLogin(`${OWN}.evil`))).status).toBe(401);
    await web.stopTailscale();
    expect((await via(port, 'GET', '/', asLogin(OWN))).status).toBe(421);
    expect(web.status().tailscale).toBeUndefined();
    expect(web.on).toBe(true);
  });

  it.skipIf(WINDOWS)('trusts nobody’s login on a tagged machine', async () => {
    const { web, port } = await tailnetAccess('tagged');
    const t = await web.goTailscale();
    expect(t.login).toBeUndefined();
    expect((await via(port, 'GET', '/', asLogin(OWN))).status).toBe(401);
    expect(tailscaleWords(t)).toContain('every browser needs a join link');
  });

  it.skipIf(WINDOWS)('says how to install Tailscale, log in, or let Serve run, in one line each', async () => {
    const missing = new TailscaleReach({ bin: path.join(dir, 'nowhere', 'tailscale') });
    await expect(missing.start(7777)).rejects.toThrow(/Tailscale isn’t installed here\. (Install it with `curl -fsSL https:\/\/tailscale\.com\/install\.sh \| sh`|Install Tailscale from)/);
    await expect(new TailscaleReach({ bin: fakeTailscale(mkdtempSync(path.join(dir, 'a-')), 'needs-login').bin }).start(7777)).rejects.toThrow('Log in with `sudo tailscale up`');
    await expect(new TailscaleReach({ bin: fakeTailscale(mkdtempSync(path.join(dir, 'b-')), 'denied').bin }).start(7777)).rejects.toThrow('sudo tailscale set --operator=$USER');
    await expect(new TailscaleReach({ bin: fakeTailscale(mkdtempSync(path.join(dir, 'c-')), 'no-https').bin }).start(7777)).rejects.toThrow('HTTPS Certificates');
  });

  it.skipIf(WINDOWS)('--off turns Serve off, and the choice is remembered until then', async () => {
    const { web, ts } = await tailnetAccess('running', true);
    await web.goTailscale();
    expect(readWebConfig()?.tailscale).toBe(true);
    await web.stop();
    expect(ts.calls().at(-1)).toEqual(['serve', '--https=443', 'off']);
    expect(readWebConfig()).toBeUndefined();
  });

  it.skipIf(WINDOWS)('shows in `beluga status`, and is typed --tailscale', async () => {
    const { web } = await tailnetAccess();
    await web.goTailscale();
    const s = web.status();
    expect(s.tailscale).toEqual({ url: `https://${NAME}`, login: OWN });
    expect(webWords({ on: s.on, ...(s.url ? { url: s.url } : {}), sessions: 0, ...(s.tailscale ? { tailscale: s.tailscale } : {}) })).toContain(`on your tailnet at https://${NAME}`);
    expect(splitWebArgs(['--tailscale']).web).toMatchObject({ tailscale: true });
  });

  it('reads `tailscale status --json` and what serve says', () => {
    expect(readSelf(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'Box.Tail.ts.net.', UserID: 7 }, User: { 7: { LoginName: 'Kay@Example.com' } } }))).toEqual({ name: 'box.tail.ts.net', login: 'kay@example.com' });
    expect(() => readSelf(JSON.stringify({ BackendState: 'Running', Self: { DNSName: '' } }))).toThrow('MagicDNS');
    expect(() => readSelf('nope')).toThrow('can’t read');
    expect(serveProblem('')).toContain('no reason given');
  });
});
