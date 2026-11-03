import { alive, runningDaemon } from '../daemon/files.js';
import { attach } from './attach.js';
import { type Exit, type Io, errorText } from './io.js';

/** How long `beluga stop` waits for Beluga to finish what it's doing and leave. */
export const STOP_WAIT_MS = 20_000;

/** Gone: daemon.json no longer names it, and (unless it's this very process, in tests) its process ended. */
const stopped = (pid: number): boolean => runningDaemon()?.pid !== pid && (pid === process.pid || !alive(pid));

async function waitUntil(done: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (done()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return done();
}

/** `beluga stop`: ask the daemon to stop as a screen would (daemon.stop), else signal it. */
export async function stop(io: Io, waitMs = STOP_WAIT_MS): Promise<Exit> {
  const info = runningDaemon();
  if (!info) {
    io.out("Beluga isn't running.\n");
    return 0;
  }
  try {
    const client = await attach(info, 5000);
    // It answers and then closes the connection, or closes it first: either way it's stopping.
    await client.call('daemon.stop').catch(() => undefined);
    client.close();
  } catch (err) {
    io.err(`Beluga didn't answer (${errorText(err)}); asking its process to stop.\n`);
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  if (await waitUntil(() => stopped(info.pid), waitMs)) {
    io.out('Beluga stopped. Start it again with `beluga up`.\n');
    return 0;
  }
  io.err(`Beluga is still stopping after ${Math.round(waitMs / 1000)} seconds (pid ${info.pid}). \`beluga logs\` shows what it's doing; \`kill ${info.pid}\` ends it.\n`);
  return 1;
}
