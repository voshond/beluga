import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { belugaHome } from '../workspaces/store.js';
import { WebAuth } from './auth.js';
import { WebGateway } from './gateway.js';

export const WEB_USAGE = `  cli.js web [--port 8420] [--host 127.0.0.1] [--tunnel] [--dist <dir>]
                                        Beluga in a browser, behind a sign-in (--tunnel: a public https:// address through Cloudflare)
  cli.js web passwd <name>              add an account for it, or change its password (read from stdin)
`;

export const webAuthPath = (): string => path.join(belugaHome(), 'web.json');

/** packages/mac/dist, from src/web or dist/web. */
const defaultDist = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/mac/dist');

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readPassword(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = '';
    for await (const chunk of stdin) text += String(chunk);
    return text.replace(/\r?\n$/, '');
  }
  // Typed: not echoed.
  process.stdout.write('Password: ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let pw = '';
    const onData = (s: string): void => {
      for (const c of s) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(pw);
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          return reject(new Error('Cancelled'));
        }
        if (c === '\u007f') pw = pw.slice(0, -1);
        else pw += c;
      }
    };
    stdin.on('data', onData);
  });
}

export async function runWeb(args: readonly string[]): Promise<void> {
  const auth = new WebAuth(webAuthPath());
  if (args[0] === 'passwd') {
    const name = args[1];
    if (!name) throw new Error('Usage: cli.js web passwd <name>');
    await auth.setPassword(name, await readPassword());
    process.stdout.write(`Saved. ${name} can sign in (and was signed out everywhere else).\n`);
    return;
  }
  if (!auth.users.length) throw new Error('No accounts yet. Add one first: cli.js web passwd <name>');

  const log = (line: string): void => void process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const host = flag(args, '--host') ?? '127.0.0.1';
  const gateway = new WebGateway({ auth, dist: flag(args, '--dist') ?? defaultDist(), port: Number(flag(args, '--port') ?? 8420), host, log });
  const port = await gateway.listen();
  log(`web: listening on http://${host}:${port}`);

  let stopTunnel: (() => void) | undefined;
  if (args.includes('--tunnel')) {
    const { openTunnel } = await import('../net/tunnel.js');
    const open = async (): Promise<void> => {
      const tunnel = await openTunnel('cloudflared', port, {
        onProgress: log,
        onDied: (why) => {
          log(`web: tunnel closed (${why}); opening a new one`);
          setTimeout(() => void open().catch((err: unknown) => log(`web: tunnel failed: ${String(err)}`)), 5_000);
        },
      });
      if (!tunnel) return;
      stopTunnel = tunnel.close;
      log(`web: open Beluga at ${tunnel.publicUrl}`);
    };
    await open();
  }

  const stop = (): void => {
    stopTunnel?.();
    void gateway.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
