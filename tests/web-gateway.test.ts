import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { LoginThrottle, WebAuth, hashPassword, verifyPassword } from '../src/web/auth.js';
import { WS_PATH, WebGateway } from '../src/web/gateway.js';

describe('web auth', () => {
  it('checks passwords against their scrypt hash', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong horse battery', h)).toBe(false);
  });

  it('holds back an address after five wrong passwords, and everyone after many', () => {
    const t = new LoginThrottle(5, 8, 1000);
    for (let i = 0; i < 5; i++) t.failed('a', 0);
    expect(t.wait('a', 10)).toBeGreaterThan(0);
    expect(t.wait('b', 10)).toBe(0);
    for (let i = 0; i < 3; i++) t.failed('c', 0);
    expect(t.wait('b', 10)).toBeGreaterThan(0);
    expect(t.wait('b', 1001)).toBe(0);
  });

  it('keeps sessions as hashes, and a new password signs out everywhere', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-web-')), 'web.json');
    const auth = new WebAuth(file);
    await auth.setPassword('voshond', 'a long password');
    const cookie = auth.startSession('voshond');
    expect(new WebAuth(file).session(cookie)).toBe('voshond');
    expect(JSON.stringify(WebAuth.read(file))).not.toContain(cookie);
    await auth.setPassword('voshond', 'another long password');
    expect(auth.session(cookie)).toBeUndefined();
  });
});

describe('web gateway', () => {
  let gateway: WebGateway;
  let daemon: WebSocketServer;
  let base: string;
  const hellos: string[] = [];

  beforeEach(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-web-'));
    const dist = path.join(dir, 'dist');
    mkdirSync(path.join(dist, 'assets'), { recursive: true });
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>window</title>');
    writeFileSync(path.join(dist, 'assets', 'a.js'), 'x');
    writeFileSync(path.join(dir, 'secret.txt'), 'nope');
    const auth = new WebAuth(path.join(dir, 'web.json'));
    await auth.setPassword('voshond', 'a long password');
    daemon = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((r) => daemon.once('listening', r));
    daemon.on('connection', (ws) => ws.on('message', (m) => (hellos.push(m.toString()), ws.send('{"t":"welcome"}'))));
    const port = (daemon.address() as { port: number }).port;
    gateway = new WebGateway({ auth, dist, port: 0, daemon: () => ({ port, token: 'real-token', version: '1', pid: process.pid }) as never });
    base = `http://127.0.0.1:${await gateway.listen()}`;
  });

  afterEach(async () => {
    await gateway.close();
    daemon.close();
    hellos.length = 0;
  });

  const login = async (password: string, origin = base): Promise<Response> =>
    fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `user=voshond&password=${encodeURIComponent(password)}` });

  it('sends a stranger to sign in, and keeps the endpoint and files from them', async () => {
    const page = await fetch(`${base}/`, { redirect: 'manual', headers: { accept: 'text/html' } });
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe('/login');
    expect((await fetch(`${base}/__beluga/endpoint`)).status).toBe(401);
    expect((await fetch(`${base}/assets/a.js`)).status).toBe(401);
  });

  it('signs in, serves the window, and never hands out the daemon token', async () => {
    expect((await login('wrong password')).status).toBe(401);
    expect((await login('a long password', 'https://evil.example')).status).toBe(403);
    const ok = await login('a long password');
    expect(ok.status).toBe(303);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0]!;
    expect(ok.headers.get('set-cookie')).toContain('HttpOnly');
    // no-referrer would make browsers post the sign-in form with "Origin: null" (refused).
    expect((await fetch(`${base}/login`)).headers.get('referrer-policy')).toBe('same-origin');

    const endpoint = await (await fetch(`${base}/__beluga/endpoint`, { headers: { cookie } })).json();
    expect(endpoint.url).toBe(WS_PATH);
    expect(JSON.stringify(endpoint)).not.toContain('real-token');
    expect(await (await fetch(`${base}/some/view`, { headers: { cookie } })).text()).toContain('window');
    expect((await fetch(`${base}/..%2Fsecret.txt`, { headers: { cookie } })).status).toBe(404);

    // A page from another site can't open the socket, even with the cookie.
    const evil = new WebSocket(`${base.replace('http', 'ws')}${WS_PATH}`, { headers: { cookie, origin: 'https://evil.example' } });
    await expect(new Promise((_, reject) => evil.once('error', reject))).rejects.toThrow(/403/);

    const ws = new WebSocket(`${base.replace('http', 'ws')}${WS_PATH}`, { headers: { cookie, origin: base } });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'hello', token: 'web-gateway', kind: 'mac' }));
    expect(String(await new Promise((r) => ws.once('message', r)))).toContain('welcome');
    expect(JSON.parse(hellos[0]!)).toMatchObject({ t: 'hello', token: 'real-token', kind: 'mac' });

    // Signing out closes its windows.
    const closed = new Promise<number>((r) => ws.once('close', r));
    await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base } });
    expect(await closed).toBe(4401);
    expect((await fetch(`${base}/__beluga/endpoint`, { headers: { cookie } })).status).toBe(401);
  });
});
