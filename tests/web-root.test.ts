import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultWebRoot } from '../src/daemon/web-static.js';

/** A server install's layout (scripts/build-server.mjs): the engine in daemon/dist/daemon, the UI in web/. */
function serverInstall(): { root: string; here: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'beluga-web-root-'));
  const here = path.join(root, 'daemon', 'dist', 'daemon');
  mkdirSync(here, { recursive: true });
  mkdirSync(path.join(root, 'web'));
  writeFileSync(path.join(root, 'web', 'index.html'), '<title>Beluga</title>');
  return { root, here };
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('where the web port finds the built UI', () => {
  it('finds the server install’s web/ from the root its launcher gives', () => {
    const { root, here } = serverInstall();
    made.push(root);
    expect(defaultWebRoot({ BELUGA_SERVER_ROOT: root }, here)).toBe(path.join(root, 'web'));
  });

  it('prefers BELUGA_WEB_ROOT, and finds nothing where there is no build', () => {
    const { root, here } = serverInstall();
    made.push(root);
    const other = path.join(root, 'other');
    mkdirSync(other);
    writeFileSync(path.join(other, 'index.html'), '');
    expect(defaultWebRoot({ BELUGA_WEB_ROOT: other, BELUGA_SERVER_ROOT: root }, here)).toBe(other);
    expect(defaultWebRoot({}, here)).toBeUndefined();
  });
});
