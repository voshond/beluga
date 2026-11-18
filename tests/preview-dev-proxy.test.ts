import { type IncomingHttpHeaders, type Server, createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { atPreviewOrigin, browserUrl } from '../packages/mac/src/components/preview/preview-model.js';
import { framableHeaders, upstreamHeaders } from '../src/preview/dev-proxy.js';
import { PreviewManager, lanAddressOf } from '../src/preview/manager.js';
import { previewPublic } from '../src/preview/public.js';
import { PreviewServer } from '../src/preview/server.js';
import type { PreviewResult } from '../src/shared/preview/opened.js';

const HOST = 'preview.example.com';
const pub = previewPublic({ BELUGA_PREVIEW_ORIGIN: `https://${HOST}`, BELUGA_PREVIEW_FRAMED_BY: 'https://beluga.example.com', BELUGA_PREVIEW_LISTEN: '127.0.0.1' });

type Answer = { readonly status?: number; readonly headers: IncomingHttpHeaders; readonly body: string };

const get = (port: number, host: string, path: string, cookie?: string): Promise<Answer> =>
  new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host, ...(cookie ? { cookie } : {}) } }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    })
      .on('error', reject)
      .end();
  });

const opened = (r: PreviewResult) => {
  if (!r.ok) throw new Error(`${r.kind}: ${r.title}`);
  return r;
};

describe('a dev server carried to the public preview origin', () => {
  let dev: Server;
  let devPort: number;
  let seen: IncomingHttpHeaders[];
  let manager: PreviewManager;
  let previewPort: number;

  beforeEach(async () => {
    seen = [];
    dev = createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/old') {
        res.writeHead(302, { location: `http://localhost:${devPort}/new?x=1` });
        return void res.end();
      }
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" });
      res.end(`page ${req.url}`);
    });
    const wss = new WebSocketServer({ server: dev });
    wss.on('connection', (socket) => socket.on('message', (m) => socket.send(`echo ${String(m)}`)));
    await new Promise<void>((r) => dev.listen(0, '127.0.0.1', r));
    devPort = (dev.address() as AddressInfo).port;
    const server = new PreviewServer(0, pub);
    manager = new PreviewManager(server, { fetcher: async () => new Response('', { status: 200 }) });
    previewPort = Number(new URL(await server.origin()).port);
  });

  afterEach(async () => {
    await manager.close();
    dev.closeAllConnections();
    await new Promise((r) => dev.close(r));
  });

  it('lets a frame in only with a ticket from Beluga, then carries the page and its hot reload', async () => {
    const out = opened(await manager.open('/tmp', { target: { kind: 'url', url: `http://127.0.0.1:${devPort}/triage?tab=2` } }));
    expect(out).toMatchObject({ kind: 'url', url: `http://127.0.0.1:${devPort}/triage?tab=2`, via: `/d/${out.id}/` });
    expect(out.ticket).toMatch(/^[0-9a-f]{48}$/);

    expect((await get(previewPort, HOST, '/triage')).status).toBe(404);
    expect((await get(previewPort, HOST, `/d/${out.id}/triage?beluga_ticket=${'0'.repeat(48)}`)).status).toBe(401);
    const entered = await get(previewPort, HOST, `/d/${out.id}/triage?tab=2&beluga_ticket=${out.ticket}`);
    expect(entered.status).toBe(303);
    expect(entered.headers.location).toBe('/triage?tab=2');
    const setCookie = entered.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toMatch(new RegExp(`^beluga_dev=${out.id}\\.\\w+; Path=/; HttpOnly; SameSite=Lax; Secure$`));
    const cookie = setCookie.split(';')[0]!;
    expect((await get(previewPort, HOST, `/d/${out.id}/triage?beluga_ticket=${out.ticket}`)).status).toBe(401);
    expect((await get(previewPort, HOST, `/d/${out.id}/triage`, cookie)).headers.location).toBe('/triage');

    const page = await get(previewPort, HOST, '/triage?tab=2', `${cookie}; theirs=1`);
    expect(page).toMatchObject({ status: 200, body: 'page /triage?tab=2' });
    expect(page.headers['x-frame-options']).toBeUndefined();
    expect(page.headers['content-security-policy']).toMatch(/^default-src 'self'; frame-ancestors tauri:\/\/localhost .* https:\/\/beluga\.example\.com$/);
    expect(seen.at(-1)).toMatchObject({ host: `127.0.0.1:${devPort}`, cookie: 'theirs=1' });
    expect((await get(previewPort, HOST, '/old', cookie)).headers.location).toBe('/new?x=1');

    expect((await get(previewPort, `127.0.0.1:${previewPort}`, '/triage', cookie)).status).toBe(404);
    expect((await get(previewPort, HOST, '/triage', 'beluga_dev=nope.nope')).status).toBe(404);

    const echoed = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${previewPort}/?token=t`, { headers: { host: HOST, cookie, origin: `https://${HOST}` } });
      ws.on('open', () => ws.send('hmr'));
      ws.on('message', (m) => (resolve(String(m)), ws.close()));
      ws.on('error', reject);
    });
    expect(echoed).toBe('echo hmr');

    const refused = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${previewPort}/`, { headers: { host: HOST } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve(undefined));
    });
    expect(refused).toBe(401);
  });

  it('keeps one entry per dev server, and none without a public origin', async () => {
    const a = opened(await manager.open('/tmp', { target: { kind: 'url', url: `http://127.0.0.1:${devPort}/a` } }));
    const b = opened(await manager.open('/tmp', { target: { kind: 'url', url: `http://127.0.0.1:${devPort}/b` } }));
    expect(b.id).toBe(a.id);
    const local = new PreviewManager(new PreviewServer(0, undefined), { fetcher: async () => new Response('') });
    const plain = opened(await local.open('/tmp', { target: { kind: 'url', url: `http://127.0.0.1:${devPort}/a` } }));
    expect(plain.via).toBeUndefined();
    expect(plain.ticket).toBeUndefined();
    await local.close();
  });
});

describe('a dev page from another computer', () => {
  it('has its network address, or says it listens on this computer only', async () => {
    const answers = async () => new Response('');
    const refuses = async (): Promise<Response> => {
      throw new Error('refused');
    };
    expect(await lanAddressOf('http://localhost:3000/x?y=1', { host: 'i9arch', ip: '192.168.2.50' }, answers)).toEqual({ lan: 'http://i9arch:3000/x?y=1' });
    expect(await lanAddressOf('http://localhost:3000/', { host: 'i9arch', ip: '192.168.2.50' }, refuses)).toEqual({ lanBlocked: true });
  });

  it('loads at its entry on the preview origin, and opens in a browser at its network address', () => {
    const id = 'cd'.repeat(16);
    const dev = { ok: true, id, url: 'http://localhost:3000/.beluga/scratch/triage.html?a=1', kind: 'url', version: 1, via: `/d/${id}/`, ticket: 'tk', lan: 'http://i9arch:3000/.beluga/scratch/triage.html?a=1' } as const;
    expect(atPreviewOrigin(dev, 'https://preview.example.com')).toMatchObject({ ok: true, url: `https://preview.example.com/d/${id}/.beluga/scratch/triage.html?a=1&beluga_ticket=tk` });
    expect(atPreviewOrigin({ ok: true, id: 'x', url: 'http://localhost:3000/', kind: 'url', version: 1 }, 'https://preview.example.com')).toMatchObject({ ok: false, kind: 'elsewhere' });
    expect(browserUrl(dev.url, dev, true)).toBe(dev.lan);
    expect(browserUrl(dev.url, dev, false)).toBe(dev.url);
    expect(browserUrl(dev.url, undefined, true)).toBe(dev.url);
  });

  it('rewrites only what the dev server needs, and only what makes it framable', () => {
    const target = { hostname: 'localhost', port: 3000 };
    expect(upstreamHeaders({ host: HOST, origin: `https://${HOST}`, referer: 'https://x/', cookie: 'beluga_dev=a.b; beluga_preview=c', accept: 'text/html' }, target, false)).toEqual({ host: 'localhost:3000', origin: 'http://localhost:3000', accept: 'text/html' });
    expect(framableHeaders({ 'x-frame-options': 'SAMEORIGIN', location: 'https://elsewhere.example/x', 'content-type': 'text/html' }, target, 'https://beluga.example.com')).toEqual({ location: 'https://elsewhere.example/x', 'content-type': 'text/html' });
  });
});
