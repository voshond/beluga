#!/usr/bin/env node
// Beluga for a server, with nothing to install first: one tarball per system,
//   beluga/bin/beluga     the command (a launcher that runs the engine with the Node beside it)
//   beluga/node/node      Node (pinned in build-sidecar.mjs, the desktop app's own)
//   beluga/daemon/        the engine (dist/ and its production node_modules)
//   beluga/web/           the Beluga UI built for a browser (packages/mac's dist)
//   beluga/VERSION
// into <out>/beluga-server-<os>-<arch>.tar.gz, with scripts/install.sh beside it.
// Usage: node scripts/build-server.mjs [--os linux|darwin] [--arch x64|arm64] [--out server-out] [--no-web]
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const flag = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const platform = flag('--os', process.platform);
const arch = flag('--arch', process.arch);
const out = path.resolve(flag('--out', path.join(root, 'server-out')));
if (!['linux', 'darwin'].includes(platform)) throw new Error(`The server bundle is for Linux and macOS, not ${platform}`);
if (!['x64', 'arm64'].includes(arch)) throw new Error(`The server bundle is for x64 and arm64, not ${arch}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

const stage = mkdtempSync(path.join(os.tmpdir(), 'beluga-server-'));
const top = path.join(stage, 'beluga');
mkdirSync(path.join(top, 'bin'), { recursive: true });

// 1. The engine and Node, as the desktop app bundles them.
run(process.execPath, [path.join(root, 'scripts/build-sidecar.mjs'), '--os', platform, '--arch', arch, '--out', path.join(top, 'daemon'), '--node-out', path.join(top, 'node', 'node')]);

// 2. The UI for a browser (the web access milestone serves it).
if (!process.argv.includes('--no-web')) {
  run('npm', ['run', 'build'], { cwd: path.join(root, 'packages/mac') });
  cpSync(path.join(root, 'packages/mac/dist'), path.join(top, 'web'), { recursive: true });
}

// 3. The command: follows its own symlink (~/.local/bin/beluga) back here, then runs the engine.
const launcher = path.join(top, 'bin', 'beluga');
copyFileSync(path.join(root, 'scripts/server-launcher.sh'), launcher);
chmodSync(launcher, 0o755);
const version = JSON.parse(readFileSync(path.join(top, 'daemon', 'package.json'), 'utf8')).version;
writeFileSync(path.join(top, 'VERSION'), `${version}\n`);

// 4. The tarball, and the script that installs it.
mkdirSync(out, { recursive: true });
const tarball = path.join(out, `beluga-server-${platform}-${arch}.tar.gz`);
rmSync(tarball, { force: true });
// No macOS metadata in it (GNU tar on the server would warn about each file's extended attributes,
// com.apple.provenance among them, which COPYFILE_DISABLE alone leaves in).
const noMacMetadata = process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : [];
run('tar', [...noMacMetadata, '-czf', tarball, '-C', stage, 'beluga'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
copyFileSync(path.join(root, 'scripts/install.sh'), path.join(out, 'install.sh'));
rmSync(stage, { recursive: true, force: true });
if (!existsSync(tarball)) throw new Error('No tarball was made');
console.log(`\nBeluga ${version} for ${platform}-${arch}: ${path.relative(process.cwd(), tarball)}`);
