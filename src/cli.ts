#!/usr/bin/env node
// The engine the Mac app runs in the background (src-tauri/src/daemon.rs starts `cli.js daemon --keep-alive`).
import { parseConfig } from './config.js';
import { runDaemon } from './daemon/main.js';
import { APP_ORIGINS } from './daemon/server.js';
import { belugaEnv } from './core/beluga-env.js';
import { installedVersion } from './core/version.js';
import { WEB_USAGE } from './web/cli.js';

const USAGE = `Beluga's engine, for the Mac app.

Usage:
  cli.js daemon [--keep-alive] [demo]   run Beluga in the background for the Mac app
${WEB_USAGE}  cli.js mcp-serve <suite>              one suite of Beluga's tools over stdio, for a run (BELUGA_TOOLS_URL, BELUGA_TOOLS_TOKEN)
  cli.js --version                      show the version
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
    process.stdout.write(`Beluga ${installedVersion()}\n`);
    return;
  }
  // Started by an agent's runtime with its run's token, never by hand (agent/tool-host.ts).
  if (args[0] === 'mcp-serve') {
    const url = belugaEnv('TOOLS_URL');
    const token = belugaEnv('TOOLS_TOKEN');
    if (!args[1] || !url || !token) throw new Error('mcp-serve needs a suite, BELUGA_TOOLS_URL and BELUGA_TOOLS_TOKEN');
    const { serveStdio } = await import('./mcp-serve.js');
    await serveStdio(args[1], url, token);
    return;
  }
  // Beluga in a browser: a sign-in in front of the window and the daemon (src/web/gateway.ts).
  if (args[0] === 'web') {
    const { runWeb } = await import('./web/cli.js');
    await runWeb(args.slice(1));
    return;
  }
  if (args[0] !== 'daemon') {
    process.stdout.write(USAGE);
    process.exitCode = args[0] === '--help' || args[0] === '-h' || args[0] === undefined ? 0 : 1;
    return;
  }
  const rest = args.slice(1).filter((a) => a !== '--keep-alive');
  // The Mac app's web view; BELUGA_ALLOW_ORIGINS adds more (its dev server while developing).
  const extra = (belugaEnv('ALLOW_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  // BELUGA_LAG_EVERY_MS: log the event-loop delay more often than every 30 s (scripts/perf-lag.mjs).
  const lagEveryMs = Number(belugaEnv('LAG_EVERY_MS')) || undefined;
  await runDaemon(parseConfig(rest), { version: installedVersion(), keepAlive: args.includes('--keep-alive') || belugaEnv('KEEP_ALIVE') === '1', allowedOrigins: [...APP_ORIGINS, ...extra], ...(lagEveryMs ? { lagEveryMs } : {}), ...(belugaEnv('STOP_ON_INPUT_END') === '1' ? { stopWithInput: process.stdin } : {}) });
}

main().catch((err: unknown) => {
  process.stderr.write(`beluga: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
