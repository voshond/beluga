import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { clearDaemonInfo, releaseLock } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { webConfigPath } from '../src/daemon/web-access.js';
import { ASK_PAGE, COOKIE } from '../src/daemon/web-join.js';
import { WebPasswords, hashPassword, webPasswordsPath } from '../src/daemon/web-passwords.js';
import { WebSessions, webSessionsPath } from '../src/daemon/web-sessions.js';
import { webCommand } from '../src/web-cli.js';
import { type Reply, builtUi, get } from './web-helpers.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const post = (port: number, body: string, headers: Record<string, string>): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/login', method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'user-agent': UA, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });

const tmpFile = (name: string): string => path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-pw-')), name);

describe('web passwords', () => {
  it('keeps scrypt hashes only, readable by you alone, and checks them', async () => {
    const file = tmpFile('web-passwords.json');
    const passwords = new WebPasswords(file, tmpFile('web.json'));
    expect(passwords.any).toBe(false);
    await passwords.set('voshond', 'a long password');
    expect(readFileSync(file, 'utf8')).not.toContain('a long password');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await passwords.check('voshond', 'a long password')).toBe('voshond');
    expect(await passwords.check('voshond', 'a wrong password')).toBeUndefined();
    expect(await passwords.check('nobody', 'a long password')).toBeUndefined();
    await expect(passwords.set('voshond', 'short')).rejects.toThrow(/10 characters/);
    await expect(passwords.set('no spaces', 'a long password')).rejects.toThrow(/letters/);
    expect(passwords.remove('voshond')).toBe(true);
    expect(passwords.remove('voshond')).toBe(false);
    expect(passwords.any).toBe(false);
  });

  it('takes over accounts kept in web.json before the web port used that file', async () => {
    const legacy = tmpFile('web.json');
    writeFileSync(legacy, JSON.stringify({ users: [{ name: 'voshond', hash: await hashPassword('the old password') }], sessions: [] }));
    const passwords = new WebPasswords(tmpFile('web-passwords.json'), legacy);
    expect(passwords.names).toEqual(['voshond']);
    expect(await passwords.check('voshond', 'the old password')).toBe('voshond');
  });
});

const daemons: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  clearDaemonInfo();
  releaseLock();
  for (const file of [webSessionsPath(), webConfigPath(), webPasswordsPath()]) rmSync(file, { force: true });
});

describe('signing in to the web port with a password', () => {
  const start = async (): Promise<{ d: RunningDaemon; port: number; origin: string }> => {
    const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true, web: { port: 0, root: builtUi() } });
    daemons.push(d);
    const port = Number(new URL(d.webUrl!).port);
    return { d, port, origin: `http://127.0.0.1:${port}` };
  };
  const login = (port: number, origin: string, user: string, password: string): Promise<Reply> => post(port, JSON.stringify({ user, password }), { origin });

  it('shows the Ask for a link page until a name has a password, then a sign-in form', async () => {
    const { port } = await start();
    expect((await get(port, '/')).body.toString()).toBe(ASK_PAGE);
    await new WebPasswords().set('voshond', 'a long password');
    const page = await get(port, '/');
    expect(page.status).toBe(401);
    expect(page.body.toString()).toContain('Sign in to Beluga');
    expect(String(page.headers['content-security-policy'])).toMatch(/script-src 'sha256-[^']+'; .*form-action 'none'/);
    expect((await get(port, '/assets/index-Ab12Cd34.js')).status).toBe(401);
  });

  it('lets a browser in with the right password only, from its own page only', async () => {
    const { port, origin } = await start();
    await new WebPasswords().set('voshond', 'a long password');
    expect((await login(port, origin, 'voshond', 'a wrong password')).status).toBe(401);
    expect((await login(port, 'http://evil.example', 'voshond', 'a long password')).status).toBe(403);
    expect((await post(port, JSON.stringify({ user: 'voshond', password: 'a long password' }), {})).status).toBe(403);
    expect((await post(port, 'user=voshond&password=x', { origin, 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    const ok = await login(port, origin, 'voshond', 'a long password');
    expect(ok.status).toBe(200);
    expect(String(ok.headers['set-cookie']?.[0])).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict`));
    const cookie = String(ok.headers['set-cookie']?.[0]).split(';')[0]!;
    expect((await get(port, '/', { cookie })).status).toBe(200);
    expect(new WebSessions().list()).toEqual([expect.objectContaining({ user: 'voshond', name: 'voshond: Chrome on Linux' })]);
  });

  it('stops answering an address after too many wrong passwords', async () => {
    const { port, origin } = await start();
    await new WebPasswords().set('voshond', 'a long password');
    for (let i = 0; i < 10; i++) expect((await login(port, origin, 'voshond', `wrong password ${i}`)).status).toBe(401);
    expect((await login(port, origin, 'voshond', 'a long password')).status).toBe(429);
  });

  it('signs a name’s browsers out when its password is removed', async () => {
    const { d, port, origin } = await start();
    await new WebPasswords().set('voshond', 'a long password');
    const cookie = String((await login(port, origin, 'voshond', 'a long password')).headers['set-cookie']?.[0]).split(';')[0]!;
    const said: string[] = [];
    await webCommand(['passwd', '--remove', 'voshond'], (t) => said.push(t));
    expect(said.join('')).toMatch(/1 browser signed out/);
    expect(d.web.sessions.list()).toEqual([]);
    expect((await get(port, '/', { cookie })).status).toBe(401);
    expect((await get(port, '/')).body.toString()).toBe(ASK_PAGE);
  });
});
