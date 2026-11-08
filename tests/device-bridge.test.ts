import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { DaemonServer } from '../src/daemon/server.js';
import { Store, initialState } from '../src/core/store.js';
import { SocketClient, type SocketLike } from '../src/ipc/socket-client.js';
import type { DeviceRequestFrame, DeviceResult } from '../src/shared/devices.js';
import { DEVICE_CAPS_OFFERED, deviceOffer, deviceOs, handleDeviceRequest } from '../packages/mac/src/lib/device-bridge.js';
import { askedBy, secondsLeft } from '../packages/mac/src/device-prompt/prompt-model.js';
import { waitFor } from './helpers.js';

/** The thin client's side of device reach (BLG-56): the page only carries frames to the app shell and back. */

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

const token = 'a'.repeat(32);

const startDaemon = async () => {
  const session = { store: new Store(initialState('room')), intents: { subscribe: () => () => undefined }, attend: () => undefined, detach: () => undefined };
  const daemon = new DaemonServer({ session: session as never, token, version: '1.0.0', uploadsRoot: '/srv/beluga/uploads' });
  const port = await daemon.listen();
  cleanup.push(() => daemon.close());
  return { daemon, port };
};

const attach = async (port: number, handle: (request: DeviceRequestFrame) => Promise<DeviceResult>) => {
  const client = await SocketClient.connect({
    url: `ws://127.0.0.1:${port}`,
    token,
    kind: 'remote-app',
    version: '1.0.0',
    device: { offer: { name: 'arch', os: 'linux', caps: DEVICE_CAPS_OFFERED }, handle },
    connect: (url) => new WebSocket(url) as unknown as SocketLike,
  });
  cleanup.push(() => client.close());
  return client;
};

const runFrame: DeviceRequestFrame = { t: 'device_request', id: 'r1', kind: 'run', payload: { command: 'uname -a' }, timeoutSec: 120, why: 'which kernel' };

describe('a remote app offering its machine', () => {
  it('offers itself in its hello and answers a request with what the shell said', async () => {
    const { daemon, port } = await startDaemon();
    const handled: DeviceRequestFrame[] = [];
    await attach(port, async (request) => {
      handled.push(request);
      return { outcome: 'ok', exitCode: 0, stdout: 'Linux arch\n', stderr: '' };
    });
    await waitFor(() => daemon.devices.list().length === 1);
    expect(daemon.devices.list()[0]).toMatchObject({ name: 'arch', os: 'linux', caps: ['device-run'] });
    const result = await daemon.devices.request('arch', { kind: 'run', payload: { command: 'uname -a' } }, { why: 'which kernel', agent: 'claude' });
    expect(result).toEqual({ outcome: 'ok', exitCode: 0, stdout: 'Linux arch\n', stderr: '' });
    expect(handled[0]).toMatchObject({ kind: 'run', payload: { command: 'uname -a' }, why: 'which kernel', agent: 'claude' });
  });

  it('passes a refusal on as refused, and a failure as an error', async () => {
    const { daemon, port } = await startDaemon();
    const answers: Array<() => Promise<DeviceResult>> = [async () => ({ outcome: 'refused', exitCode: null, error: 'Denied at the device.' }), () => Promise.reject(new Error('the shell is gone'))];
    await attach(port, () => answers.shift()!());
    await waitFor(() => daemon.devices.list().length === 1);
    const ask = () => daemon.devices.request('arch', { kind: 'run', payload: { command: 'ls' } }, { why: 'look' });
    expect(await ask()).toEqual({ outcome: 'refused', exitCode: null, error: 'Denied at the device.' });
    expect(await ask()).toEqual({ outcome: 'error', error: 'the shell is gone' });
  });
});

describe('device bridge', () => {
  it('hands a command to the app shell as it came, and nothing else for now', async () => {
    const invoke = vi.fn(async () => ({ outcome: 'refused' }) as never);
    expect(await handleDeviceRequest(runFrame, invoke)).toEqual({ outcome: 'refused' });
    expect(invoke).toHaveBeenCalledWith('device_run', { request: runFrame });
    const shot: DeviceRequestFrame = { t: 'device_request', id: 'r2', kind: 'screenshot', payload: {}, timeoutSec: 120, why: 'see' };
    expect(await handleDeviceRequest(shot, invoke)).toEqual({ outcome: 'error', error: "This device can't do screenshot requests yet" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('offers the machine only from the app as a client', async () => {
    const invoke = vi.fn(async () => ({ deviceName: 'arch' }) as never);
    expect(await deviceOffer(invoke)).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('tells the OS from the page agent the shell sets', () => {
    expect(deviceOs('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 BelugaApp/0.4.0')).toBe('linux');
    expect(deviceOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) BelugaApp/0.4.0')).toBe('macos');
    expect(deviceOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130')).toBe('windows');
  });
});

describe('the approval window', () => {
  it('says who asked and counts down to the automatic no', () => {
    expect(askedBy({ agent: 'claude', conversation: 'Fix the build' })).toBe('claude on your Beluga server asks, from Fix the build.');
    expect(askedBy({ agent: null, conversation: null })).toBe('An agent on your Beluga server asks.');
    expect(secondsLeft(10_500, 0)).toBe(11);
    expect(secondsLeft(0, 5_000)).toBe(0);
  });
});
