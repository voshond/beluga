import { cpSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { clearDaemonInfo, releaseLock } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { isPublicFile, webConfigPath } from '../src/daemon/web-access.js';
import { webSessionsPath } from '../src/daemon/web-sessions.js';
import { builtUi, get } from './web-helpers.js';

const MAC = path.resolve(import.meta.dirname, '../packages/mac');
const manifest = JSON.parse(readFileSync(path.join(MAC, 'public/manifest.webmanifest'), 'utf8')) as {
  name: string;
  start_url: string;
  display: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
};
/** A PNG's width and height, from its header. */
const pngSize = (file: string): [number, number] => {
  const b = readFileSync(file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

describe('the installable web app', () => {
  it('has a manifest that opens standalone, with Beluga’s icons at their stated sizes', () => {
    expect(manifest).toMatchObject({ name: 'Beluga', start_url: '/', display: 'standalone' });
    for (const size of ['192x192', '512x512']) expect(manifest.icons.some((i) => i.sizes === size && i.purpose === 'any')).toBe(true);
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
      const [w, h] = pngSize(path.join(MAC, 'public', icon.src));
      expect(`${w}x${h}`, icon.src).toBe(icon.sizes);
    }
    expect(pngSize(path.join(MAC, 'public/icons/apple-touch-icon.png'))).toEqual([180, 180]);
    const index = readFileSync(path.join(MAC, 'index.html'), 'utf8');
    expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(index).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
  });

  it('keeps nothing offline: no service worker anywhere in the app', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n)) : [path.join(dir, n)]));
    const offenders = files(path.join(MAC, 'src')).filter((f) => /\.(ts|tsx)$/.test(f) && /serviceWorker|caches\.open/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('only the manifest and icons are public', () => {
    expect(isPublicFile('/manifest.webmanifest')).toBe(true);
    expect(isPublicFile('/icons/icon-192.png')).toBe(true);
    expect(isPublicFile('/icons/../daemon.json')).toBe(false);
    expect(isPublicFile('/icons/x.js')).toBe(false);
    expect(isPublicFile('/index.html')).toBe(false);
    expect(isPublicFile('/')).toBe(false);
  });
});

describe('the web port and installing', () => {
  const daemons: RunningDaemon[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.stop();
    clearDaemonInfo();
    releaseLock();
    rmSync(webSessionsPath(), { force: true });
    rmSync(webConfigPath(), { force: true });
  });

  it('serves the manifest and icons to a browser not let in yet, and nothing else', async () => {
    const root = builtUi();
    cpSync(path.join(MAC, 'public'), root, { recursive: true });
    const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true, web: { port: 0, root } });
    daemons.push(d);
    const port = Number(new URL(d.webUrl!).port);
    const m = await get(port, '/manifest.webmanifest');
    expect(m.status).toBe(200);
    expect(m.headers['content-type']).toContain('application/manifest+json');
    expect(JSON.parse(m.body.toString())).toMatchObject({ name: 'Beluga' });
    const icon = await get(port, '/icons/icon-192.png');
    expect(icon.status).toBe(200);
    expect(icon.headers['content-type']).toBe('image/png');
    expect((await get(port, '/', {})).status).toBe(401);
    expect((await get(port, '/assets/index-Ab12Cd34.js')).status).toBe(401);
    expect((await get(port, '/manifest.webmanifest', {}, 'POST')).status).toBe(401);
  });
});
