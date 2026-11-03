import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Io } from '../src/cli/io.js';
import { INSTALL_LINE, update, updateScript } from '../src/cli/update.js';

const INSTALL = path.resolve('scripts/install.sh');
const LAUNCHER = path.resolve('scripts/server-launcher.sh');

function capture(): Io & { readonly text: () => string; readonly errors: () => string } {
  let out = '';
  let err = '';
  return { out: (t) => void (out += t), err: (t) => void (err += t), text: () => out, errors: () => err };
}

/** A bundle shaped like build-server.mjs's, whose "Node" is a shell script: installs in a blink. */
function fakeBundle(version: string): string {
  const stage = mkdtempSync(path.join(os.tmpdir(), 'beluga-fake-bundle-'));
  const top = path.join(stage, 'beluga');
  for (const dir of ['bin', 'node', 'daemon/dist']) mkdirSync(path.join(top, dir), { recursive: true });
  writeFileSync(path.join(top, 'bin/beluga'), readFileSync(LAUNCHER));
  // "node cli.js <command>": version says which bundle this is; status says nothing runs.
  writeFileSync(path.join(top, 'node/node'), `#!/bin/sh\n[ "$1" = --version ] && exit 0\ncase $2 in version) echo "Beluga ${version} from $BELUGA_SERVER_ROOT" ;; status) exit 1 ;; esac\n`);
  writeFileSync(path.join(top, 'daemon/dist/cli.js'), '');
  chmodSync(path.join(top, 'bin/beluga'), 0o755);
  chmodSync(path.join(top, 'node/node'), 0o755);
  const tarball = path.join(stage, 'beluga-server.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', stage, 'beluga']);
  return tarball;
}

const install = (home: string, tarball: string): string =>
  execFileSync('sh', [INSTALL], { env: { PATH: process.env.PATH, HOME: home, BELUGA_DOWNLOAD_URL: `file://${tarball}` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe.skipIf(process.platform === 'win32')('the install script', () => {
  it('installs to ~/.beluga/server and links beluga into ~/.local/bin, no sudo; running it again updates in place', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-install-home-'));
    const first = install(home, fakeBundle('1.0.0'));
    const server = path.join(home, '.beluga', 'server');
    expect(first).toContain(`Installed Beluga 1.0.0 from ${server}`);
    expect(first).toContain("isn't on your PATH yet");
    expect(first).toContain('Next: `beluga setup`');
    const link = path.join(home, '.local', 'bin', 'beluga');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(path.join(server, 'bin', 'beluga'));
    // Through the link, the launcher finds its own folder.
    expect(execFileSync(link, ['version'], { encoding: 'utf8' }).trim()).toBe(`Beluga 1.0.0 from ${server}`);

    const second = install(home, fakeBundle('1.1.0'));
    expect(second).toContain('Installed Beluga 1.1.0');
    expect(execFileSync(link, ['version'], { encoding: 'utf8' })).toContain('1.1.0');
    expect(existsSync(`${server}.old`)).toBe(false);
  });

  it('installs in a UTF-8 terminal too (a Mac’s sh read "$arch…" as one name and stopped)', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-install-home-'));
    const out = execFileSync('sh', [INSTALL], { env: { PATH: process.env.PATH, HOME: home, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', BELUGA_DOWNLOAD_URL: `file://${fakeBundle('1.0.0')}` }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toContain('Downloading Beluga for');
    expect(existsSync(path.join(home, '.local/bin/beluga'))).toBe(true);
  });

  it('says plainly when the download is no bundle', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-install-home-'));
    const junk = path.join(home, 'junk.tar.gz');
    writeFileSync(junk, 'not a tarball');
    let said = '';
    try {
      install(home, junk);
    } catch (err) {
      said = String((err as { stderr?: string }).stderr);
    }
    expect(said).toContain("Beluga could not be installed: the download isn't a Beluga bundle");
    expect(existsSync(path.join(home, '.beluga', 'server'))).toBe(false);
  });
});

describe('beluga update', () => {
  it('runs the install script again on a server install', async () => {
    const scripts: string[] = [];
    expect(await update(capture(), { serverRoot: '/home/kay/.beluga/server', run: async (s) => (scripts.push(s), 0) })).toBe(0);
    expect(scripts[0]).toContain('releases/latest/download/install.sh');
    const failed = capture();
    expect(await update(failed, { serverRoot: '/x', run: async () => 1 })).toBe(1);
    expect(failed.errors()).toContain(INSTALL_LINE);
  });

  it.skipIf(process.platform === 'win32')('fails when the install script can’t be downloaded, and runs it whole when it can', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-update-'));
    const sh = (script: string): { code: number; out: string; err: string } => {
      try {
        return { code: 0, out: execFileSync('sh', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' };
      } catch (e) {
        const x = e as { status: number; stdout: string; stderr: string };
        return { code: x.status, out: x.stdout, err: x.stderr };
      }
    };
    const missing = sh(updateScript(`file://${dir}/no-such-install.sh`));
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Couldn't download");
    writeFileSync(path.join(dir, 'install.sh'), 'echo first line\necho installed\n');
    const ok = sh(updateScript(`file://${dir}/install.sh`));
    expect(ok).toEqual({ code: 0, out: 'first line\ninstalled\n', err: '' });
  });

  it('leaves the desktop app and a source copy to their own updates', async () => {
    const io = capture();
    const prev = process.env.BELUGA_SERVER_ROOT;
    delete process.env.BELUGA_SERVER_ROOT;
    try {
      expect(await update(io, { run: async () => 0 })).toBe(1);
    } finally {
      if (prev !== undefined) process.env.BELUGA_SERVER_ROOT = prev;
    }
    expect(io.errors()).toContain('desktop app updates itself');
  });
});
