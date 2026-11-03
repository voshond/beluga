import { parseConfig } from '../config.js';
import { runDaemon } from '../daemon/main.js';
import { webCommand } from '../web-cli.js';
import { qrLines } from './qr.js';
import { useClaudeToken } from './claude.js';
import { daemonOptions } from './daemon.js';
import { type Exit, type Io, errorText } from './io.js';

/**
 * `beluga web [--listen host:port] [--allow-host name] [--insecure-http] [demo]`, and `web sessions |
 * link | revoke <name> | stop` (web-cli.ts): a join link from the Beluga that runs, or Beluga run
 * here, kept alive, with its web port open and the link said on this terminal.
 */
export async function web(argv: readonly string[], io: Io): Promise<Exit> {
  let served: Awaited<ReturnType<typeof webCommand>>;
  try {
    served = await webCommand(argv, io.out);
  } catch (err) {
    io.err(`${errorText(err)}\n`);
    return 1;
  }
  if (!served) return 0;
  useClaudeToken();
  await runDaemon(parseConfig(served.rest), { ...daemonOptions(true), web: served.web, announce: io.out, ...(process.stdout.isTTY ? { announceQr: qrLines } : {}) });
  return 0;
}
