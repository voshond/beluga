import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tunnel } from '../src/net/tunnel.js';
import { PUBLIC_JOIN_LIMITS, PublicReach, publicWords } from '../src/daemon/reach/public.js';
import { WebAccess, readWebConfig, webConfigPath } from '../src/daemon/web-access.js';
import { splitWebArgs } from '../src/daemon/web.js';
import { SECURE_COOKIE } from '../src/daemon/web-join.js';
import { webSessionsPath } from '../src/daemon/web-sessions.js';
import { webWords } from '../src/cli/status.js';
import { type Reply, builtUi } from './web-helpers.js';
import { waitFor } from './helpers.js';

/** A Cloudflare that opens tunnels on demand: each gets a new name, and can be made to die. */
function fakeCloudflare(): { open: (port: number, onDied: (reason: string) => void) => Promise<Tunnel>; opened: Array<{ port: number; url: string; closed: boolean; die: () => void }> } {
  const opened: Array<{ port: number; url: string; closed: boolean; die: () => void }> = [];
  return {
    opened,
    open: async (port, onDied) => {
      const t = { port, url: `https://quiet-river-${opened.length + 1}.trycloudflare.com`, closed: false, die: () => onDied('cloudflared stopped (code 1)') };
      opened.push(t);
      return { kind: 'cloudflared', publicUrl: t.url, close: () => void (t.closed = true) };
    },
  };
}

/** A request to the web port as Cloudflare's edge hands it over: under the public name, from loopback, saying who the visitor is. */
function via(port: number, method: string, urlPath: string, opts: { host: string; visitor?: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers = { host: opts.host, ...(opts.visitor ? { 'cf-connecting-ip': opts.visitor, 'x-forwarded-proto': 'https' } : {}), ...opts.headers };
    const req = request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

const join = (port: number, host: string, secret: string, visitor?: string): Promise<Reply> =>
  via(port, 'POST', '/join', { host, ...(visitor ? { visitor } : {}), headers: { origin: host.includes(':') ? `http://${host}` : `https://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ secret }) });

const accesses: WebAccess[] = [];
afterEach(async () => {
  for (const w of accesses.splice(0)) await w.close();
  rmSync(webSessionsPath(), { force: true });
  rmSync(webConfigPath(), { force: true });
});

async function publicAccess(remember = false): Promise<{ web: WebAccess; port: number; cf: ReturnType<typeof fakeCloudflare> }> {
  const cf = fakeCloudflare();
  const web = new WebAccess({ door: { adopt: (ws) => ws.close() }, root: builtUi(), remember, publicReach: { open: cf.open, reachable: async () => true, retryMs: () => 10 } });
  accesses.push(web);
  await web.start({ port: 0 });
  const port = Number(new URL(web.status().url!).port);
  return { web, port, cf };
}

describe('beluga web --public (BLG-658)', () => {
  it('gives the trycloudflare address and a join link under it; the address alone shows only the Ask page', async () => {
    const { web, port, cf } = await publicAccess();
    const pub = await web.goPublic();
    expect(pub.url).toBe('https://quiet-river-1.trycloudflare.com');
    expect(cf.opened[0]!.port).toBe(port);
    expect(pub.link.url).toMatch(/^https:\/\/quiet-river-1\.trycloudflare\.com\/join#[A-Za-z0-9_-]{16,}$/);
    const host = 'quiet-river-1.trycloudflare.com';

    const ask = await via(port, 'GET', '/', { host, visitor: '203.0.113.9', headers: { accept: 'text/html' } });
    expect(ask.status).toBe(401);
    expect(ask.body.toString()).toContain('Ask for a link to open Beluga');
    expect((await via(port, 'GET', '/assets/index-Ab12Cd34.js', { host, visitor: '203.0.113.9' })).status).toBe(401);
    // Any other name is refused (no tunnel or DNS trick reaches the port under a name it doesn't know).
    expect((await via(port, 'GET', '/', { host: 'evil.example', visitor: '203.0.113.9' })).status).toBe(421);

    const joined = await join(port, host, pub.link.url.split('#')[1]!, '203.0.113.9');
    expect(joined.status).toBe(200);
    const cookie = String(joined.headers['set-cookie']?.[0]);
    expect(cookie.startsWith(`${SECURE_COOKIE}=`)).toBe(true);
    expect(cookie).toContain('Secure');
    const ui = await via(port, 'GET', '/', { host, visitor: '203.0.113.9', headers: { cookie: cookie.split(';')[0]! } });
    expect(ui.status).toBe(200);
    expect(ui.body.toString()).toContain('<title>Beluga</title>');

    expect(web.status().public).toEqual({ state: 'on', url: pub.url });
    expect(publicWords(pub)).toContain('anyone who has a join link');
    expect(publicWords(pub)).toContain('`beluga web --off` closes it');

    web.stopPublic();
    expect(cf.opened[0]!.closed).toBe(true);
    expect(web.status().public).toBeUndefined();
    expect((await via(port, 'GET', '/', { host, visitor: '203.0.113.9' })).status).toBe(421);
    expect(web.on).toBe(true);
  });

  it('survives a cloudflared restart: a new address, announced in the status', async () => {
    const { web, cf } = await publicAccess();
    await web.goPublic();
    cf.opened[0]!.die();
    expect(web.status().public).toEqual({ state: 'reopening' });
    await waitFor(() => web.status().public?.state === 'on', 5000);
    expect(web.status().public).toEqual({ state: 'on', url: 'https://quiet-river-2.trycloudflare.com' });
    expect(cf.opened).toHaveLength(2);
    expect(web.public.host).toBe('quiet-river-2.trycloudflare.com');
    // `beluga status` says the new one.
    const status = web.status();
    expect(webWords({ on: status.on, sessions: 0, ...(status.public ? { public: status.public } : {}) })).toContain('public at https://quiet-river-2.trycloudflare.com');
  });

  it('keeps trying when Cloudflare is slow to give a new tunnel, and stops trying once turned off', async () => {
    let fails = 2;
    const cf = fakeCloudflare();
    const reach = new PublicReach({ open: async (port, died) => (fails-- > 0 && cf.opened.length ? Promise.reject(new Error('cloudflared exited (code 1)')) : cf.open(port, died)), reachable: async () => true, retryMs: () => 10 });
    await reach.start(7777);
    cf.opened[0]!.die();
    await waitFor(() => reach.state?.state === 'on', 5000);
    expect(reach.state?.url).toBe('https://quiet-river-2.trycloudflare.com');
    cf.opened[1]!.die();
    reach.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(cf.opened).toHaveLength(2);
    expect(reach.state).toBeUndefined();
  });

  it('is remembered for the next start until --off', async () => {
    const { web } = await publicAccess(true);
    await web.goPublic();
    expect(readWebConfig()?.public).toBe(true);
    web.stopPublic();
    expect(readWebConfig()?.public).toBeUndefined();
    await web.goPublic();
    await web.stop();
    expect(readWebConfig()).toBeUndefined();
    expect(web.status().public).toBeUndefined();
  });

  it('opens cloudflared at the web port, and a new one when it exits', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-cf-'));
    const log = path.join(dir, 'calls.log');
    // A cloudflared that says its address like the real one (on stderr), then dies on the first run.
    writeFileSync(
      path.join(dir, 'cloudflared'),
      `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const n = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;
process.stderr.write('INF |  https://fake-tunnel-' + n + '.trycloudflare.com  |\\n');
if (n === 1) setTimeout(() => process.exit(1), 300); else setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`,
    );
    chmodSync(path.join(dir, 'cloudflared'), 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${before}`;
    const reach = new PublicReach({ reachable: async () => true, retryMs: () => 10 });
    try {
      expect(await reach.start(7790)).toBe('https://fake-tunnel-1.trycloudflare.com');
      await waitFor(() => reach.state?.url === 'https://fake-tunnel-2.trycloudflare.com', 10_000);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
      expect(calls[0]).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7790']);
    } finally {
      reach.stop();
      process.env.PATH = before;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('takes --public from what was typed', () => {
    expect(splitWebArgs(['--public']).web).toMatchObject({ public: true, host: '127.0.0.1', port: 7777 });
    expect(splitWebArgs([]).web.public).toBeUndefined();
  });
});

describe('join limits through the public address (BLG-658)', () => {
  it('allows fewer wrong links per visitor and in all than the local port, and a good link still works', async () => {
    const { web, port } = await publicAccess();
    const pub = await web.goPublic();
    const host = new URL(pub.url).host;
    const wrong = 'A'.repeat(22);
    for (let i = 0; i < PUBLIC_JOIN_LIMITS.perAddress; i++) expect((await join(port, host, wrong, '198.51.100.1')).status).toBe(401);
    const limited = await join(port, host, wrong, '198.51.100.1');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('600');
    // Another visitor still gets its own tries (Cloudflare's word for the address, not loopback's).
    expect((await join(port, host, wrong, '198.51.100.2')).status).toBe(401);
    // The local port has its own, looser count.
    expect((await join(port, `127.0.0.1:${port}`, wrong)).status).toBe(401);
    // A good link always works: junk can't lock its owner out.
    expect((await join(port, host, web.sessions.link(pub.url).url.split('#')[1]!, '198.51.100.1')).status).toBe(200);
  });

  it('stops every visitor once the total is reached', async () => {
    const { web, port } = await publicAccess();
    const pub = await web.goPublic();
    const host = new URL(pub.url).host;
    const wrong = 'B'.repeat(22);
    for (let i = 0; i < PUBLIC_JOIN_LIMITS.total; i++) expect((await join(port, host, wrong, `192.0.2.${i}`)).status).toBe(401);
    expect((await join(port, host, wrong, '192.0.2.250')).status).toBe(429);
    // Not the local port: a different limiter.
    expect((await join(port, `127.0.0.1:${port}`, wrong)).status).toBe(401);
  });
});
