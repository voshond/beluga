import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { belugaHome } from '../src/core/home.js';
import { REVOKED_CLOSE, WebServer, hostAllowed, parseListen, sameOrigin, splitWebArgs, webUrl } from '../src/daemon/web.js';
import { IMMUTABLE, REVALIDATE, StaticFiles, pickEncoding, resolveInRoot } from '../src/daemon/web-static.js';
import { BIG_JS, builtUi, get, upgrade } from './web-helpers.js';

const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function webOnly(opts: Partial<ConstructorParameters<typeof WebServer>[0]> = {}): Promise<{ server: WebServer; port: number; adopted: WebSocket[] }> {
  const adopted: WebSocket[] = [];
  const server = new WebServer({ door: { adopt: (ws) => void adopted.push(ws) }, port: 0, root: builtUi(), authorize: () => 'me', ...opts });
  servers.push(server);
  const { port } = await server.listen();
  return { server, port, adopted };
}

describe('static files', () => {
  it('serves index revalidated, hashed bundles for a year, and 304s on a matching etag', async () => {
    const { port } = await webOnly();
    const index = await get(port, '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.headers['cache-control']).toBe(REVALIDATE);
    const js = await get(port, '/assets/index-Ab12Cd34.js');
    expect(js.headers['cache-control']).toBe(IMMUTABLE);
    expect(js.body.toString()).toBe(BIG_JS);
    const again = await get(port, '/assets/index-Ab12Cd34.js', { 'if-none-match': String(js.headers.etag) });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    expect((await get(port, '/icon.png')).headers['cache-control']).toBe(REVALIDATE);
  });

  it('compresses text with br, else gzip, and leaves images alone', async () => {
    const { port } = await webOnly();
    const br = await get(port, '/assets/index-Ab12Cd34.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(br.body).toString()).toBe(BIG_JS);
    const gz = await get(port, '/assets/index-Ab12Cd34.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).toString()).toBe(BIG_JS);
    expect(gz.headers.etag).not.toBe(br.headers.etag);
    const png = await get(port, '/icon.png', { 'accept-encoding': 'br' });
    expect(png.headers['content-encoding']).toBeUndefined();
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('identity')).toBe('identity');
    expect(pickEncoding(undefined)).toBe('identity');
  });

  it('never leaves its root, and serves no dotfiles, folders or Beluga files', async () => {
    const { port } = await webOnly();
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json', '/assets/%2e%2e%5c%2e%2e%5cpackage.json', '/.env', '/assets', '/assets/', '/daemon.json', '/nope.js', '/index.html%00.js', '/%E0%A4%A']) {
      expect((await get(port, p)).status, p).toBe(404);
    }
    const root = mkdtempSync(path.join(os.tmpdir(), 'r-'));
    expect(resolveInRoot(root, '/a/../../b')).toBeUndefined();
    expect(resolveInRoot(root, '/a/b.js')).toBe(path.join(root, 'a', 'b.js'));
  });

  it("won't use Beluga's home, or a folder holding it, as a root", () => {
    expect(() => new StaticFiles(belugaHome())).toThrow(/Beluga's own files/);
    expect(() => new StaticFiles(path.dirname(belugaHome()))).toThrow(/Beluga's own files/);
  });

  it('only GET and HEAD, security headers on every answer, and a page when the UI is not built', async () => {
    const { port } = await webOnly();
    expect((await get(port, '/', {}, 'POST')).status).toBe(405);
    const head = await get(port, '/', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers['x-frame-options']).toBe('DENY');
    expect(head.headers['x-content-type-options']).toBe('nosniff');
    expect(head.headers['referrer-policy']).toBe('no-referrer');
    const empty = mkdtempSync(path.join(os.tmpdir(), 'beluga-web-empty-'));
    const bare = await webOnly({ root: empty });
    // An empty folder is still a root (it was given); with none at all the page says how to build.
    expect((await get(bare.port, '/')).status).toBe(404);
  });
});

describe('who the web port answers', () => {
  it('only under loopback names, IP addresses and the hosts it was given (no DNS rebinding)', async () => {
    const { port } = await webOnly();
    expect((await get(port, '/', { host: `evil.example:${port}` })).status).toBe(421);
    expect((await get(port, '/', { host: `localhost:${port}` })).status).toBe(200);
    expect(hostAllowed('box.tail1234.ts.net', ['box.tail1234.ts.net'])).toBe(true);
    expect(hostAllowed('box.tail1234.ts.net')).toBe(false);
    expect(hostAllowed('[::1]:7777')).toBe(true);
    expect(hostAllowed('100.101.102.103:7777')).toBe(true);
    expect(hostAllowed('a b')).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it("opens the socket only for a page of its own origin and a let-in browser", async () => {
    const { port, adopted } = await webOnly();
    const own = `http://127.0.0.1:${port}`;
    expect((await upgrade(port, {})).status).toBe(403);
    expect((await upgrade(port, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await upgrade(port, { origin: `http://127.0.0.1:${port + 1}` })).status).toBe(403);
    expect((await upgrade(port, { origin: 'tauri://localhost' })).status).toBe(403);
    expect((await upgrade(port, { origin: own }, '/'))).toMatchObject({ status: 404 });
    expect((await upgrade(port, { origin: `http://evil.example:${port}`, host: `evil.example:${port}` })).status).toBe(421);
    const ok = await upgrade(port, { origin: own });
    expect(ok.status).toBe(101);
    expect(adopted).toHaveLength(1);
    ok.ws?.close();
    expect(sameOrigin('https://box.ts.net', 'box.ts.net')).toBe(true);
    expect(sameOrigin('https://box.ts.net', 'box.ts.net:8443')).toBe(false);
    expect(sameOrigin('null', 'box.ts.net')).toBe(false);
  });

  it('refuses the socket to a browser it has not let in', async () => {
    const { port } = await webOnly({ authorize: () => undefined });
    expect((await upgrade(port, { origin: `http://127.0.0.1:${port}` })).status).toBe(401);
    // Nor its files.
    expect((await get(port, '/')).status).toBe(401);
    expect((await get(port, '/assets/index-Ab12Cd34.js')).status).toBe(401);
  });

  it("cuts a session's sockets off at once when it's dropped", async () => {
    const sessions = ['a', 'b'];
    let next = 0;
    const { server, port } = await webOnly({ authorize: () => sessions[next++ % 2] });
    const a = await upgrade(port, { origin: `http://127.0.0.1:${port}` });
    const b = await upgrade(port, { origin: `http://127.0.0.1:${port}` });
    const closed = new Promise<number>((r) => a.ws?.once('close', (code) => r(code)));
    server.drop('a');
    expect(await closed).toBe(REVOKED_CLOSE);
    expect(b.ws?.readyState).toBe(WebSocket.OPEN);
    b.ws?.close();
  });
});

describe('beluga web flags', () => {
  it('takes --listen and --allow-host and leaves the rest', () => {
    expect(splitWebArgs(['demo'])).toEqual({ web: { host: '127.0.0.1', port: 7777, allowedHosts: [] }, rest: ['demo'] });
    expect(splitWebArgs(['--listen', '0.0.0.0:8080', '--allow-host=Box.ts.net', '--no-agent'])).toEqual({ web: { host: '0.0.0.0', port: 8080, allowedHosts: ['box.ts.net'] }, rest: ['--no-agent'] });
    expect(splitWebArgs(['--listen=7778']).web).toMatchObject({ host: '127.0.0.1', port: 7778 });
    expect(parseListen('[::1]:7777')).toEqual({ host: '::1', port: 7777 });
    expect(parseListen('::')).toEqual({ host: '::' });
    expect(() => parseListen('host:99999')).toThrow();
    expect(() => splitWebArgs(['--listen'])).toThrow();
    expect(webUrl('0.0.0.0', 7777)).toBe('http://127.0.0.1:7777');
    expect(webUrl('::1', 7777)).toBe('http://[::1]:7777');
  });
});
