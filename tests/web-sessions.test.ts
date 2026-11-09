import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.js';
import { clearDaemonInfo, daemonInfoPath, releaseLock } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { REVOKED_CLOSE, WEB_HELLO_TOKEN } from '../src/daemon/web.js';
import { readWebConfig, webConfigPath } from '../src/daemon/web-access.js';
import { ASK_PAGE, COOKIE, SECURE_COOKIE } from '../src/daemon/web-join.js';
import { IDLE_MS, JOIN_TTL_MS, JoinLimiter, WebSessions, describeBrowser, webSessionsPath } from '../src/daemon/web-sessions.js';
import { SocketClient, type SocketLike } from '../src/ipc/socket-client.js';
import { webCommand } from '../src/web-cli.js';
import { type Reply, builtUi, get, upgrade } from './web-helpers.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const sessionsFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-web-sessions-')), 'web-sessions.json');
const secretOf = (link: string): string => link.split('#')[1]!;

describe('web sessions', () => {
  it('trades a join link for a session once, and keeps only its hash, readable by you alone', () => {
    const file = sessionsFile();
    const sessions = new WebSessions({ file });
    const link = sessions.link('http://127.0.0.1:7777/');
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:7777\/join#[A-Za-z0-9_-]{22}$/);
    const joined = sessions.redeem(secretOf(link.url), UA);
    expect(joined?.session).toMatchObject({ name: 'Safari on macOS', browser: 'Safari', os: 'macOS' });
    expect(sessions.redeem(secretOf(link.url), UA)).toBeUndefined();
    expect(sessions.check(joined!.cookie)).toBe(joined!.session.id);
    expect(sessions.check('nope')).toBeUndefined();
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain(joined!.cookie);
    expect(onDisk).not.toContain(secretOf(link.url));
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    // Another start of the daemon knows it.
    expect(new WebSessions({ file }).check(joined!.cookie)).toBe(joined!.session.id);
    expect(JSON.stringify(sessions.list())).not.toContain('hash');
  });

  it('lets a join link expire after 10 minutes, and forgets a browser idle for 90 days', () => {
    let now = 1_000_000;
    const sessions = new WebSessions({ file: sessionsFile(), now: () => now });
    const late = sessions.link('http://h');
    now += JOIN_TTL_MS;
    expect(sessions.redeem(secretOf(late.url), UA)).toBeUndefined();
    const joined = sessions.redeem(secretOf(sessions.link('http://h').url), UA)!;
    now += IDLE_MS - 1;
    expect(sessions.check(joined.cookie)).toBe(joined.session.id);
    now += IDLE_MS + 1;
    expect(sessions.check(joined.cookie)).toBeUndefined();
    expect(sessions.list()).toEqual([]);
  });

  it('revokes by id or name, says which when a name is shared, and cuts it off', () => {
    const revoked: string[] = [];
    const sessions = new WebSessions({ file: sessionsFile(), onRevoke: (id) => revoked.push(id) });
    const join = () => sessions.redeem(secretOf(sessions.link('http://h').url), UA)!;
    const a = join();
    const b = join();
    expect(b.session.name).toBe('Safari on macOS 2');
    expect(() => sessions.revoke('Firefox on Linux')).toThrow(/No browser/);
    expect(sessions.revoke('safari on macos').id).toBe(a.session.id);
    expect(sessions.revoke(b.session.id).id).toBe(b.session.id);
    expect(revoked).toEqual([a.session.id, b.session.id]);
    expect(sessions.check(a.cookie)).toBeUndefined();
  });

  it('names browsers from their User-Agent', () => {
    expect(describeBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toEqual({ browser: 'Chrome', os: 'Windows' });
    expect(describeBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toEqual({ browser: 'Firefox', os: 'Linux' });
    expect(describeBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'Safari', os: 'iPhone' });
    expect(describeBrowser(undefined)).toEqual({ browser: 'Browser', os: 'a computer' });
  });

  it('limits wrong join attempts per address and in all', () => {
    let now = 0;
    const limiter = new JoinLimiter(2, 3, 1000, () => now);
    limiter.failed('a');
    limiter.failed('a');
    expect(limiter.allowed('a')).toBe(false);
    expect(limiter.allowed('b')).toBe(true);
    limiter.failed('b');
    expect(limiter.allowed('c')).toBe(false);
    now = 1001;
    expect(limiter.allowed('a')).toBe(true);
  });
});

function post(port: number, urlPath: string, body: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'user-agent': UA, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const daemons: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  clearDaemonInfo();
  releaseLock();
  rmSync(webSessionsPath(), { force: true });
  rmSync(webConfigPath(), { force: true });
});

describe('beluga web', () => {
  const start = async (): Promise<{ d: RunningDaemon; port: number; origin: string }> => {
    const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true, web: { port: 0, root: builtUi() } });
    daemons.push(d);
    const port = Number(new URL(d.webUrl!).port);
    return { d, port, origin: `http://127.0.0.1:${port}` };
  };
  const join = async (port: number, origin: string, secret: string, extra: Record<string, string> = {}): Promise<Reply> => post(port, '/join', JSON.stringify({ secret }), { origin, ...extra });
  const cookieOf = (res: Reply): string => String(res.headers['set-cookie']?.[0]).split(';')[0]!;
  const browser = (origin: string, cookie: string) => (url: string): SocketLike => new WebSocket(url, { headers: { origin, cookie } }) as unknown as SocketLike;

  it("serves only the Ask for a link page and refuses the socket until a browser joins", async () => {
    const { port, origin } = await start();
    const page = await get(port, '/');
    expect(page.status).toBe(401);
    expect(page.body.toString()).toBe(ASK_PAGE);
    expect((await get(port, '/assets/index-Ab12Cd34.js')).status).toBe(401);
    expect((await get(port, '/index.html')).body.toString()).toBe(ASK_PAGE);
    expect(JSON.parse((await get(port, '/__beluga/endpoint')).body.toString())).toMatchObject({ signedOut: true });
    expect((await upgrade(port, { origin })).status).toBe(401);
    expect((await upgrade(port, { origin, cookie: `${COOKIE}=forged` })).status).toBe(401);
  });

  it('lets a browser in once per link, with a cookie scripts and other sites never get', async () => {
    const { d, port, origin } = await start();
    const { url } = d.web.sessions.link(d.webUrl!);
    const secret = secretOf(url);
    const joinPage = await get(port, '/join');
    expect(joinPage.status).toBe(200);
    // The page clears the secret from the address bar before anything else, and runs only its own script.
    const html = joinPage.body.toString();
    expect(html.indexOf("history.replaceState(null,'','/join')")).toBeLessThan(html.indexOf('fetch('));
    expect(String(joinPage.headers['content-security-policy'])).toMatch(/script-src 'sha256-[^']+'; /);
    expect(html).not.toContain(secret);
    // Another site can't make the exchange (CSRF), nor a form post.
    expect((await join(port, 'http://evil.example', secret)).status).toBe(403);
    expect((await post(port, '/join', JSON.stringify({ secret }), {})).status).toBe(403);
    expect((await post(port, '/join', `secret=${secret}`, { origin, 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    const ok = await join(port, origin, secret);
    expect(ok.status).toBe(200);
    const setCookie = String(ok.headers['set-cookie']?.[0]);
    expect(setCookie).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
    expect(ok.body.toString()).not.toContain(cookieOf(ok).split('=')[1]);
    // Once only.
    expect((await join(port, origin, secret)).status).toBe(401);
    // Let in: the UI, and the socket through the daemon's own accept path, no token in sight.
    const cookie = cookieOf(ok);
    expect((await get(port, '/', { cookie })).status).toBe(200);
    expect(JSON.parse((await get(port, '/__beluga/endpoint', { cookie })).body.toString())).toEqual({ web: true });
    const screen = await SocketClient.connect({ url: `ws://127.0.0.1:${port}/ws`, token: WEB_HELLO_TOKEN, kind: 'mac', version: '1.0.0', connect: browser(origin, cookie) });
    expect(screen.store.getState().room).toBe(d.core.room);
    // The socket still needs the page's own origin, cookie or not.
    expect((await upgrade(port, { origin: 'http://evil.example', cookie })).status).toBe(403);
    screen.close();
  });

  it('marks the cookie Secure (and __Host-) when the page is on https', async () => {
    const { d, port } = await start();
    const ok = await join(port, `https://127.0.0.1:${port}`, secretOf(d.web.sessions.link(d.webUrl!).url));
    expect(String(ok.headers['set-cookie']?.[0])).toMatch(new RegExp(`^${SECURE_COOKIE.replace(/[-_]/g, '.')}=.+; Secure$`));
  });

  it('lists and revokes browsers over the API, and a revoked one drops at once', async () => {
    const { d, port, origin } = await start();
    const app = await SocketClient.connect({ url: `ws://127.0.0.1:${d.port}`, token: d.token, kind: 'test', version: '1.0.0' });
    const link = await app.call('web.link');
    expect(link.url.startsWith(`${d.webUrl}/join#`)).toBe(true);
    const cookie = cookieOf(await join(port, origin, secretOf(link.url)));
    const screen = await SocketClient.connect({ url: `ws://127.0.0.1:${port}/ws`, token: WEB_HELLO_TOKEN, kind: 'mac', version: '1.0.0', connect: browser(origin, cookie) });
    const status = await app.call('web.sessions.list');
    expect(status).toMatchObject({ on: true, url: d.webUrl, sessions: [{ name: 'Safari on macOS', browser: 'Safari', os: 'macOS' }] });
    expect(JSON.stringify(status)).not.toContain(cookie.split('=')[1]);
    const closed = new Promise<string>((r) => screen.onClose(r));
    await app.call('web.sessions.revoke', 'Safari on macOS');
    expect(await closed).toBe('This browser was signed out');
    expect((await get(port, '/', { cookie })).status).toBe(401);
    expect((await upgrade(port, { origin, cookie })).status).toBe(401);
    expect((await app.call('web.sessions.list')).sessions).toEqual([]);
    expect(REVOKED_CLOSE).toBe(4401);
    app.close();
  });

  it('turns wrong secrets away for a while after too many, but a good link still works (BLG-653)', async () => {
    const { d, port, origin } = await start();
    for (let i = 0; i < 10; i++) expect((await join(port, origin, 'A'.repeat(22))).status).toBe(401);
    expect((await join(port, origin, 'B'.repeat(22))).status).toBe(429);
    expect((await join(port, origin, secretOf(d.web.sessions.link(d.webUrl!).url))).status).toBe(200);
  });

  it('remembers the port for the next start until it is stopped', async () => {
    const { d } = await start();
    expect(readWebConfig()).toMatchObject({ host: '127.0.0.1' });
    const app = await SocketClient.connect({ url: `ws://127.0.0.1:${d.port}`, token: d.token, kind: 'test', version: '1.0.0' });
    await app.call('web.stop');
    expect(readWebConfig()).toBeUndefined();
    expect((await app.call('web.sessions.list')).on).toBe(false);
    app.close();
    // daemon.json's token was never part of any of it.
    expect(readFileSync(daemonInfoPath(), 'utf8')).toContain(d.token);
  });
});

describe('the beluga web command', () => {
  const run = async (...argv: string[]): Promise<{ text: string; served: Awaited<ReturnType<typeof webCommand>> }> => {
    let text = '';
    const served = await webCommand(argv, (t) => void (text += t));
    return { text, served };
  };

  it('runs Beluga here when none is, and lists and revokes from the file', async () => {
    expect((await run('--listen', '7790', 'demo')).served).toEqual({ web: { host: '127.0.0.1', port: 7790, allowedHosts: [] }, rest: ['demo'] });
    expect((await run('sessions')).text).toMatch(/No browsers are let in/);
    const sessions = new WebSessions();
    sessions.redeem(secretOf(sessions.link('http://h').url), UA);
    expect((await run('sessions')).text).toMatch(/Safari on macOS {2,}joined/);
    expect((await run('revoke', 'Safari', 'on', 'macOS')).text).toBe('Safari on macOS is signed out.\n');
    await expect(run('revoke')).rejects.toThrow(/Which browser/);
    expect((await run('stop')).text).toMatch(/isn’t running/);
  });

  it('asks the running Beluga for a link, its browsers, a revoke and to close the port', async () => {
    const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true, web: { port: 0, root: builtUi() } });
    daemons.push(d);
    const port = Number(new URL(d.webUrl!).port);
    const linked = await run();
    expect(linked.served).toBeUndefined();
    const url = /(http:\S+\/join#\S+)/.exec(linked.text)?.[1];
    expect(url?.startsWith(`${d.webUrl}/join#`)).toBe(true);
    expect((await post(port, '/join', JSON.stringify({ secret: secretOf(url!) }), { origin: d.webUrl! })).status).toBe(200);
    expect((await run('sessions')).text).toContain('Safari on macOS');
    expect((await run('revoke', 'Safari on macOS')).text).toBe('Safari on macOS is signed out and cut off.\n');
    expect((await run('stop')).text).toMatch(/closed/);
    expect(d.web.on).toBe(false);
  });
});
