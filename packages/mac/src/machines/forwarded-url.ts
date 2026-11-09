// Relative, not @beluga: the root's tests read this file too.
import type { SocketClient } from '../../../../src/ipc/socket-client.js';
import type { PortForward } from '../../../../src/shared/forwards.js';

/**
 * A page a computer serves on its own localhost (a live preview, a dev server), as this Mac reaches
 * it: the same address with the port the app forwarded it to (src/machines/forward.ts). A port is
 * forwarded once the forwarder sees it (it looks every 3 s), so this waits for it a little; a page
 * that isn't on the computer's localhost, or isn't forwarded in time, comes back as it was.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const WAIT_MS = 8_000;

/** `url` with the computer's port swapped for this Mac's; undefined while that forward isn't known yet. */
export function swapPort(url: string, machineId: string, forwards: readonly PortForward[]): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!LOOPBACK.has(u.hostname) || !u.port) return url;
  const f = forwards.find((x) => x.machineId === machineId && x.port === Number(u.port));
  if (!f) return undefined;
  u.port = String(f.local);
  return u.toString();
}

/** As this Mac reaches it: waits up to WAIT_MS for the forward, else the address as it was. */
export function forwardedUrl(home: SocketClient, machineId: string, url: string): Promise<string> {
  const now = (): string | undefined => swapPort(url, machineId, home.store.getState().forwards ?? []);
  const at = now();
  if (at) return Promise.resolve(at);
  return new Promise((resolve) => {
    const off = home.store.subscribe(() => {
      const got = now();
      if (got) done(got);
    });
    const timer = setTimeout(() => done(url), WAIT_MS);
    function done(found: string): void {
      off();
      clearTimeout(timer);
      resolve(found);
    }
  });
}
