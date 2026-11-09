import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { DaemonServer } from '../src/daemon/server.js';
import { Store, initialState } from '../src/core/store.js';
import { SocketClient, type SocketLike } from '../src/ipc/socket-client.js';
import type { DeviceRequestFrame, DeviceResult } from '../src/shared/devices.js';
import { deviceCaps, deviceOffer, deviceOs, handleDeviceRequest } from '../packages/mac/src/lib/device-bridge.js';
import { actionLabel, askedBy, headline, secondsLeft, sizeText } from '../packages/mac/src/device-prompt/prompt-model.js';
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
    device: { offer: { name: 'arch', os: 'linux', caps: deviceCaps('linux') }, handle },
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
    expect(daemon.devices.list()[0]).toMatchObject({ name: 'arch', os: 'linux', caps: ['device-run', 'device-file', 'device-screenshot'] });
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
  const noUpload = vi.fn(async () => ({ path: '/never' }));

  it('hands a command to the app shell as it came, and brings back its answer', async () => {
    const invoke = vi.fn(async () => ({ outcome: 'refused' }) as never);
    expect(await handleDeviceRequest(runFrame, invoke, noUpload)).toEqual({ outcome: 'refused' });
    expect(invoke).toHaveBeenCalledWith('device_run', { request: runFrame });
    expect(noUpload).not.toHaveBeenCalled();
  });

  it('uploads an approved file under its own name, and a screenshot as a png', async () => {
    const uploaded: File[] = [];
    const upload = async (file: File) => {
      uploaded.push(file);
      return { path: `/home/me/.beluga/uploads/2026-11-08/ab/${file.name}` };
    };
    const invoke = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer as never);
    const file: DeviceRequestFrame = { t: 'device_request', id: 'r2', kind: 'file', payload: { path: '/home/me/notes/today.md' }, timeoutSec: 120, why: 'read' };
    expect(await handleDeviceRequest(file, invoke, upload)).toEqual({ outcome: 'ok', path: '/home/me/.beluga/uploads/2026-11-08/ab/today.md' });
    expect(invoke).toHaveBeenLastCalledWith('device_file', { request: file });
    const shot: DeviceRequestFrame = { t: 'device_request', id: 'r3', kind: 'screenshot', payload: {}, timeoutSec: 120, why: 'see' };
    const result = await handleDeviceRequest(shot, invoke, upload, () => new Date('2026-11-08T13:05:09Z'));
    expect(result).toEqual({ outcome: 'ok', path: '/home/me/.beluga/uploads/2026-11-08/ab/screenshot-20261108-130509.png' });
    expect(invoke).toHaveBeenLastCalledWith('device_screenshot', { request: shot });
    expect(uploaded.map((f) => [f.name, f.size, f.type])).toEqual([
      ['today.md', 3, 'application/octet-stream'],
      ['screenshot-20261108-130509.png', 3, 'image/png'],
    ]);
  });

  it('passes on a refusal from the shell, and a failed upload as an error', async () => {
    const file: DeviceRequestFrame = { t: 'device_request', id: 'r2', kind: 'file', payload: { path: '/big.iso' }, timeoutSec: 120, why: 'read' };
    const refusing = vi.fn(() => Promise.reject({ outcome: 'refused', exitCode: null, error: 'Files over 512 MB are refused.' }));
    expect(await handleDeviceRequest(file, refusing, noUpload)).toEqual({ outcome: 'refused', exitCode: null, error: 'Files over 512 MB are refused.' });
    const sending = vi.fn(async () => new ArrayBuffer(1) as never);
    const failing = () => Promise.reject(new Error('The upload of big.iso didn’t work'));
    expect(await handleDeviceRequest(file, sending, failing)).toEqual({ outcome: 'error', error: 'The upload of big.iso didn’t work' });
  });

  it('offers no screenshots on Windows yet', () => {
    expect(deviceCaps('windows')).toEqual(['device-run', 'device-file']);
    expect(deviceCaps('macos')).toContain('device-screenshot');
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

  it('names what is asked, with the size of a file before anything is read', () => {
    const asked = { id: 'x', device: 'arch', conversation: null, agent: null, why: '', expiresAt: 0 };
    expect(headline({ ...asked, kind: 'file', path: '/a', size: 5 })).toBe('Send this file from arch?');
    expect(headline({ ...asked, kind: 'screenshot' })).toBe('Send a screenshot of arch?');
    expect(actionLabel({ ...asked, kind: 'run', cwd: '/', command: 'ls', timeoutSec: 1 })).toBe('Run');
    expect(sizeText(5)).toBe('5 bytes');
    expect(sizeText(3 * 1024 * 1024)).toBe('3 MB (3,145,728 bytes)');
  });
});
