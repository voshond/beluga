import WebSocket from 'ws';
import { installedVersion } from '../core/version.js';
import { runningDaemon } from '../daemon/files.js';
import type { DaemonInfo } from '../ipc/protocol.js';
import { type SocketLike, SocketClient } from '../ipc/socket-client.js';

/** Said when a command needs the daemon and it isn't running. */
export const NOT_RUNNING = "Beluga isn't running. Start it with `beluga up`.\n";

/**
 * Attach to the running daemon as a terminal screen, through daemon.json's port and token.
 * Node's own WebSocket sends no Origin, which the daemon accepts from this computer.
 */
export function attach(info: DaemonInfo, timeoutMs = 10_000): Promise<SocketClient> {
  return SocketClient.connect({
    url: `ws://127.0.0.1:${info.port}`,
    token: info.token,
    kind: 'cli',
    version: installedVersion(),
    launchDir: process.cwd(),
    timeoutMs,
    connect: (url) => new WebSocket(url) as unknown as SocketLike,
  });
}

/** Run something against the running daemon, then detach; undefined when none is running. */
export async function withDaemon<T>(use: (client: SocketClient, info: DaemonInfo) => Promise<T>): Promise<T | undefined> {
  const info = runningDaemon();
  if (!info) return undefined;
  const client = await attach(info);
  try {
    return await use(client, info);
  } finally {
    client.close();
  }
}
