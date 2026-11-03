import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { browseDir } from '../src/core/local.js';
import { clearDaemonInfo, releaseLock } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { webConfigPath } from '../src/daemon/web-access.js';
import { DOWNLOAD_TTL_MS, WebFiles, safeName, uploadsDir } from '../src/daemon/web-files.js';
import { webSessionsPath } from '../src/daemon/web-sessions.js';
import { SocketClient } from '../src/ipc/socket-client.js';
import { type Reply, builtUi, get } from './web-helpers.js';

function send(port: number, urlPath: string, body: Buffer | string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-length': String(Buffer.byteLength(body)), ...headers } }, (res) => {
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

/** A daemon with its web port, a browser let in, and the Mac app on the token socket. */
async function setUp(): Promise<{ d: RunningDaemon; port: number; origin: string; cookie: string; app: SocketClient }> {
  const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true, web: { port: 0, root: builtUi() } });
  daemons.push(d);
  const port = Number(new URL(d.webUrl!).port);
  const origin = `http://127.0.0.1:${port}`;
  const secret = d.web.sessions.link(d.webUrl!).url.split('#')[1]!;
  const joined = await send(port, '/join', JSON.stringify({ secret }), { origin, 'content-type': 'application/json' });
  const cookie = String(joined.headers['set-cookie']?.[0]).split(';')[0]!;
  const app = await SocketClient.connect({ url: `ws://127.0.0.1:${d.port}`, token: d.token, kind: 'test', version: '1.0.0' });
  return { d, port, origin, cookie, app };
}

describe('uploads from a browser', () => {
  it('lands the file in ~/.beluga/uploads, readable only by you, and says where', async () => {
    const { port, origin, cookie, app } = await setUp();
    const res = await send(port, `/upload?name=${encodeURIComponent('../../notes .md')}`, 'hello there', { origin, cookie, 'content-type': 'application/octet-stream' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString()) as { path: string; name: string; size: number };
    expect(body).toMatchObject({ name: 'notes .md', size: 11 });
    expect(body.path.startsWith(uploadsDir() + path.sep)).toBe(true);
    expect(readFileSync(body.path, 'utf8')).toBe('hello there');
    if (process.platform !== 'win32') expect(statSync(body.path).mode & 0o777).toBe(0o600);
    app.close();
  });

  it('refuses a browser not let in, another origin, and a file too big', async () => {
    const { port, origin, cookie, app } = await setUp();
    expect((await send(port, '/upload?name=a', 'x', { origin })).status).toBe(401);
    expect((await send(port, '/upload?name=a', 'x', { origin: 'http://evil.example', cookie })).status).toBe(403);
    expect((await send(port, '/upload?name=a', 'x', { cookie })).status).toBe(403);
    expect((await send(port, '/upload?name=a', 'x', { origin, cookie, 'content-length': String(600 * 1024 * 1024) }).catch(() => ({ status: 413 }))).status).toBe(413);
    expect((await get(port, '/upload', { cookie })).status).toBe(405);
    app.close();
  });

  it('keeps names to a name', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('..\\..\\x.txt')).toBe('x.txt');
    expect(safeName('.env')).toBe('env');
    expect(safeName('a\u0000b<>:"|?*.txt')).toBe('ab.txt');
    expect(safeName('')).toBe('file');
  });
});

describe('downloads to a browser', () => {
  it('gives a one-time link to a file here, only to a browser let in', async () => {
    const { port, cookie, app } = await setUp();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-dl-'));
    writeFileSync(path.join(dir, 'report é.csv'), 'a,b\n1,2\n');
    const link = await app.call('web.download', { path: path.join(dir, 'report é.csv') });
    expect(link.url).toMatch(/^\/download\/[A-Za-z0-9_-]+$/);
    expect((await get(port, link.url)).status).toBe(401);
    const got = await get(port, link.url, { cookie });
    expect(got.status).toBe(200);
    expect(got.body.toString()).toBe('a,b\n1,2\n');
    expect(String(got.headers['content-disposition'])).toContain("filename*=UTF-8''report%20%C3%A9.csv");
    expect((await get(port, link.url, { cookie })).status).toBe(404);
    await expect(app.call('web.download', { path: dir })).rejects.toThrow(/isn't a file/);
    app.close();
  });

  it('lets a link expire after a minute, and deletes a copy made for it once sent', () => {
    let now = 0;
    const files = new WebFiles(() => now);
    const copy = files.scratch('x.txt');
    writeFileSync(copy, 'x');
    files.offer(copy, { temporary: true });
    now += DOWNLOAD_TTL_MS + 1;
    // The next offer sweeps the expired one (and its copy).
    const other = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-dl-')), 'y.txt');
    writeFileSync(other, 'y');
    files.offer(other);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});

describe('the folder picker in a browser', () => {
  it("lists a folder's folders, git ones first, hidden ones left out, with its parent", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'beluga-browse-'));
    for (const d of ['zeta', 'alpha', '.hidden', 'repo/.git']) mkdirSync(path.join(root, d), { recursive: true });
    writeFileSync(path.join(root, 'file.txt'), '');
    const at = browseDir(root);
    expect(at.path).toBe(root);
    expect(at.parent).toBe(path.dirname(root));
    expect(at.dirs).toEqual([
      { name: 'repo', git: true },
      { name: 'alpha', git: false },
      { name: 'zeta', git: false },
    ]);
    expect(browseDir(path.join(root, 'file.txt')).path).toBe(root);
    expect(browseDir(path.join(root, 'nope')).path).toBe(os.homedir());
    expect(browseDir().path).toBe(os.homedir());
    expect(browseDir('/').parent).toBeUndefined();
  });
});
