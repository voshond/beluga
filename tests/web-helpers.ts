import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

/** Shared by the web port's tests (web-port, web-sessions). */

export const BIG_JS = `export const hello = ${JSON.stringify('beluga '.repeat(400))};\n`;

/** A built UI: index, a hashed bundle, an icon, and things that must never be served. */
export function builtUi(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'beluga-web-root-'));
  mkdirSync(path.join(root, 'assets'));
  writeFileSync(path.join(root, 'index.html'), `<!doctype html><title>Beluga</title>${'<!-- pad -->'.repeat(200)}`);
  writeFileSync(path.join(root, 'assets', 'index-Ab12Cd34.js'), BIG_JS);
  writeFileSync(path.join(root, 'icon.png'), Buffer.alloc(2048, 7));
  writeFileSync(path.join(root, '.env'), 'SECRET=1');
  writeFileSync(path.join(root, 'daemon.json'), '{"token":"leaked"}');
  return root;
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export function get(port: number, urlPath: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: urlPath, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Open a socket on the web port; resolves with the HTTP status it was refused with, or 101. */
export function upgrade(port: number, headers: Record<string, string>, urlPath = '/ws'): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, { headers });
    ws.once('open', () => resolve({ status: 101, ws }));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.once('error', () => resolve({ status: 0 }));
  });
}
