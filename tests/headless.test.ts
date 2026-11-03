import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { idleWhenWatched, deliver } from '../src/companion/push.js';
import { parseConfig } from '../src/config.js';
import { COPY, PASTE, clipboardTools, run } from '../src/core/clipboard.js';
import { clearDaemonInfo, releaseLock, runningDaemon } from '../src/daemon/files.js';
import { type RunningDaemon, startDaemon } from '../src/daemon/main.js';
import { type SocketLike, SocketClient } from '../src/ipc/socket-client.js';
import { waitFor } from './helpers.js';

/**
 * A server, or a Mac with the app closed: no window is attached. Nothing may wait for one, and
 * what a window would have shown goes to the phone (BLG-645).
 */

const running: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
  clearDaemonInfo();
  releaseLock();
});

const startAlone = async (opts: Partial<Parameters<typeof startDaemon>[1]> = {}): Promise<RunningDaemon> => {
  const d = await startDaemon(parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay']), { version: '1.0.0', keepAlive: true, ...opts });
  running.push(d);
  return d;
};

const screen = (d: RunningDaemon, kind: 'cli' | 'test') =>
  SocketClient.connect({ url: `ws://127.0.0.1:${d.port}`, token: d.token, kind, version: '1.0.0', connect: (url) => new WebSocket(url) as unknown as SocketLike });

/** Settles within `ms`, or says it hung. */
const quickly = <T,>(p: Promise<T>, ms = 1500): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung waiting for a screen')), ms))]);

describe('a kept-alive daemon with no window', () => {
  it('never stops for lack of screens: none at first, nor after the last one leaves', async () => {
    const d = await startAlone({ firstClientMs: 30, lingerMs: 30 });
    await new Promise((r) => setTimeout(r, 150));
    expect(runningDaemon()?.port).toBe(d.port);
    const s = await screen(d, 'test');
    await waitFor(() => d.server.clients.size === 1);
    s.close();
    await waitFor(() => d.server.clients.size === 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(runningDaemon()?.port).toBe(d.port);
    let stopped = false;
    void d.done.then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(stopped).toBe(false);
  });
});

describe('what needed a window, with none attached', () => {
  it("answers every screen capability at once instead of waiting: copy, zoom, raise, notify", async () => {
    const d = await startAlone();
    for (const cap of ['copyText', 'zoom', 'raise', 'openExternal', 'readClipboardImage', 'notify'] as const) {
      await expect(quickly(d.server.callCap(cap, []))).rejects.toThrow(/No screen can/);
    }
    expect(() => d.server.notify([{ title: 'Done', body: 'All tests pass', sound: false }])).not.toThrow();
    // The session's own uses: a window to the front, text size.
    await expect(quickly(d.core.session.showOnScreens({ type: 'navigate', view: { kind: 'room' } }))).resolves.toBe(false);
    await expect(quickly(d.core.session.zoom('in'))).resolves.toBeUndefined();
  });

  it("a terminal attached (`beluga status`) can't do a window's job, and isn't asked to", async () => {
    const d = await startAlone();
    const cli = await screen(d, 'cli');
    await waitFor(() => d.server.clients.size === 1);
    await expect(quickly(d.server.callCap('copyText', ['x']))).rejects.toThrow(/No screen can/);
    // Nor does it count as someone looking (that would hold the phone's notifications).
    await new Promise((r) => setTimeout(r, 100));
    expect(d.core.session.attention.screens).toBe(0);
    const win = await screen(d, 'test');
    await waitFor(() => d.core.session.attention.screens === 1);
    win.close();
    cli.close();
    await waitFor(() => d.core.session.attention.screens === 0);
  });
});

describe('telling the phone when no window is open', () => {
  it('ignores the keyboard while no window is attached: someone typing on the server is not you at Beluga', async () => {
    let windows = 0;
    const idle = idleWhenWatched(() => windows, async () => 1_000);
    expect(await idle()).toBeUndefined();
    const ctx = { linked: false, onScreen: new Set<string>(), inFront: false, macFront: false, canPush: true };
    const none = await idle();
    expect(deliver({ kind: 'needsYou' }, { ...ctx, ...(none !== undefined ? { macIdleMs: none } : {}) })).toBe('push');
    windows = 1;
    const used = await idle();
    expect(used).toBe(1_000);
    expect(deliver({ kind: 'needsYou' }, { ...ctx, macIdleMs: used! })).toBe('held');
  });
});

describe('the clipboard on a box with no desktop', () => {
  it('uses no Linux tool without its display, so nothing is spawned to fail', () => {
    expect(clipboardTools(COPY, 'linux', {})).toEqual([]);
    expect(clipboardTools(PASTE, 'linux', {})).toEqual([]);
    expect(clipboardTools(COPY, 'linux', { DISPLAY: ':0' }).map((t) => t.cmd)).toEqual(['xclip', 'xsel']);
    expect(clipboardTools(COPY, 'linux', { WAYLAND_DISPLAY: 'wayland-0' }).map((t) => t.cmd)).toEqual(['wl-copy']);
    expect(clipboardTools(COPY, 'darwin', {}).map((t) => t.cmd)).toEqual(['pbcopy']);
  });

  it('gives up on a tool that never answers', async () => {
    const hang = { cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 20000)'] };
    await expect(quickly(run(hang, 'x', 200), 3000)).rejects.toThrow(/didn't answer/);
  });
});
