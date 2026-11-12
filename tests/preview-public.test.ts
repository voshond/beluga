import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { atPreviewOrigin } from '../packages/mac/src/components/preview/preview-model.js';
import { appCsp } from '../src/daemon/web.js';
import { previewPublic } from '../src/preview/public.js';
import { FRAME_ANCESTORS, PreviewServer, componentCsp, frameAncestors, send } from '../src/preview/server.js';

const ID = 'ab'.repeat(16);

const statusFor = (port: number, host: string): Promise<number | undefined> =>
  new Promise((resolve) => request({ host: '127.0.0.1', port, path: `/p/${ID}/`, headers: { host } }, (res) => (res.resume(), resolve(res.statusCode))).end());

describe('previews at a public origin', () => {
  let server: PreviewServer | undefined;
  afterEach(() => server?.close());

  it('is on only with an origin and who may frame it', () => {
    expect(previewPublic({})).toBeUndefined();
    expect(previewPublic({ BELUGA_PREVIEW_ORIGIN: 'https://preview.example.com' })).toBeUndefined();
    expect(previewPublic({ BELUGA_PREVIEW_ORIGIN: 'ftp://preview.example.com', BELUGA_PREVIEW_FRAMED_BY: 'https://beluga.example.com' })).toBeUndefined();
    expect(previewPublic({ BELUGA_PREVIEW_ORIGIN: 'https://preview.example.com/sub', BELUGA_PREVIEW_FRAMED_BY: 'https://beluga.example.com' })).toBeUndefined();
    expect(previewPublic({ BELUGA_PREVIEW_ORIGIN: 'https://Preview.Example.com/', BELUGA_PREVIEW_FRAMED_BY: 'https://beluga.example.com, http://box:7777 nonsense https://preview.example.com' })).toEqual({
      origin: 'https://preview.example.com',
      host: 'preview.example.com',
      framedBy: ['https://beluga.example.com', 'http://box:7777'],
      listen: '0.0.0.0',
    });
    expect(previewPublic({ BELUGA_PREVIEW_ORIGIN: 'https://preview.example.com', BELUGA_PREVIEW_FRAMED_BY: 'https://beluga.example.com', BELUGA_PREVIEW_LISTEN: '192.168.2.10' })?.listen).toBe('192.168.2.10');
  });

  it('lets the web port’s pages frame previews, besides the app', () => {
    expect(frameAncestors(undefined)).toBe(FRAME_ANCESTORS);
    const pub = previewPublic({ BELUGA_PREVIEW_ORIGIN: 'https://preview.example.com', BELUGA_PREVIEW_FRAMED_BY: 'https://beluga.example.com' });
    expect(componentCsp(frameAncestors(pub))).toMatch(/frame-ancestors tauri:\/\/localhost .* https:\/\/beluga\.example\.com$/);
  });

  it('answers at its public host name, and still refuses others', async () => {
    const pub = previewPublic({ BELUGA_PREVIEW_ORIGIN: 'https://preview.example.com', BELUGA_PREVIEW_FRAMED_BY: 'https://beluga.example.com', BELUGA_PREVIEW_LISTEN: '127.0.0.1' });
    server = new PreviewServer(0, pub);
    server.add(ID, { serve: (_rest, _req, res) => (send(res, 200, 'text/plain', 'hi'), true) });
    const port = Number(new URL(await server.origin()).port);
    expect(await statusFor(port, 'preview.example.com')).toBe(200);
    expect(await statusFor(port, `127.0.0.1:${port}`)).toBe(200);
    expect(await statusFor(port, 'evil.example')).toBe(421);
  });

  it('lets the web port’s page frame the preview origin', () => {
    expect(appCsp('box:7777', false)).not.toContain('frame-src');
    expect(appCsp('beluga.example.com', true, 'https://preview.example.com')).toContain("frame-src 'self' https://preview.example.com;");
  });

  it('loads a page from the web port’s previews at their public origin', () => {
    const opened = { ok: true, id: ID, url: `http://127.0.0.1:47791/p/${ID}/?v=2`, kind: 'component', version: 2 } as const;
    expect(atPreviewOrigin(opened, 'https://preview.example.com')).toEqual({ ...opened, url: `https://preview.example.com/p/${ID}/?v=2` });
    expect(atPreviewOrigin({ ok: true, id: 'x', url: 'http://localhost:5173/', kind: 'url', version: 1 }, 'https://preview.example.com')).toMatchObject({ ok: false, kind: 'elsewhere' });
    const failed = { ok: false, kind: 'build', title: 'No', detail: 'No' } as const;
    expect(atPreviewOrigin(failed, 'https://preview.example.com')).toBe(failed);
  });
});
