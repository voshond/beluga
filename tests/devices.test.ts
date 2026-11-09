import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { DaemonServer } from '../src/daemon/server.js';
import { Devices, devicesOf } from '../src/core/devices/index.js';
import { DEVICES_HANDLERS } from '../src/ipc/devices-handlers.js';
import { Store, initialState } from '../src/core/store.js';
import { IPC_VERSION, encodeFrame, parseDaemonFrame, type ClientFrame, type DaemonFrame } from '../src/ipc/protocol.js';
import type { DeviceCap, DeviceOs, DeviceRequestFrame } from '../src/shared/devices.js';
import { waitFor } from './helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanup.splice(0).reverse()) await c();
});

const token = 'a'.repeat(32);
const UPLOADS = '/srv/beluga/uploads';

type FakeScreen = {
  readonly requests: DeviceRequestFrame[];
  readonly answer: (frame: ClientFrame) => void;
  readonly drop: () => void;
};

const startDaemon = async (graceSec = 30) => {
  const session = { store: new Store(initialState('room')), intents: { subscribe: () => () => undefined }, attend: () => undefined, detach: () => undefined };
  const daemon = new DaemonServer({ session: session as never, token, version: '1.0.0', uploadsRoot: UPLOADS, deviceGraceSec: graceSec });
  const port = await daemon.listen();
  cleanup.push(() => daemon.close());
  return { daemon, session, port };
};

const connect = (port: number, hello: Partial<Extract<ClientFrame, { t: 'hello' }>>): Promise<FakeScreen> => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const requests: DeviceRequestFrame[] = [];
  cleanup.push(() => ws.close());
  return new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(encodeFrame({ t: 'hello', token, ipc: IPC_VERSION, kind: 'remote-app', version: '1.0.0', caps: [], ...hello })));
    ws.on('message', (raw) => {
      const frame: DaemonFrame = parseDaemonFrame(raw.toString());
      if (frame.t === 'welcome') resolve({ requests, answer: (f) => ws.send(encodeFrame(f)), drop: () => ws.close() });
      if (frame.t === 'device_request') requests.push(frame);
    });
    ws.on('error', reject);
  });
};

const box: { name: string; os: DeviceOs; caps: DeviceCap[] } = { name: 'm1arch', os: 'linux', caps: ['device-run', 'device-file', 'device-screenshot'] };

describe('Devices (core)', () => {
  const make = (graceSec?: number) => {
    const sent: DeviceRequestFrame[] = [];
    const devices = new Devices({ send: (_id, f) => void sent.push(f), uploadsRoot: UPLOADS, ...(graceSec !== undefined ? { graceSec } : {}) });
    return { devices, sent };
  };

  it('never offers a screen without device caps', () => {
    const { devices } = make();
    devices.offer('a', { name: 'empty', os: 'linux', caps: [] });
    expect(devices.list()).toEqual([]);
  });

  it('times out at timeoutSec plus 30 s of grace for the approval', async () => {
    vi.useFakeTimers();
    const { devices } = make();
    devices.offer('a', box);
    const done = devices.request('m1arch', { kind: 'run', payload: { command: 'ls' } }, { timeoutSec: 10, why: 'look' });
    const failed = vi.fn();
    done.catch(failed);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(String(failed.mock.calls[0]?.[0])).toMatch(/didn't answer within 40s/);
  });

  it('clamps timeouts to 600 s and defaults to 120 s', () => {
    const { devices, sent } = make();
    devices.offer('a', box);
    void devices.request('m1arch', { kind: 'run', payload: { command: 'ls' } }, { timeoutSec: 5000, why: 'x' }).catch(() => undefined);
    void devices.request('m1arch', { kind: 'screenshot', payload: {} }, { why: 'x' }).catch(() => undefined);
    expect(sent.map((f) => f.timeoutSec)).toEqual([600, 120]);
    devices.close();
  });

  it('says clearly when nothing or nothing by that name is connected, or the device does not allow it', async () => {
    const { devices } = make();
    await expect(devices.request('m1arch', { kind: 'screenshot', payload: {} }, { why: 'x' })).rejects.toThrow('No client device is connected');
    devices.offer('a', { name: 'm1arch', os: 'windows', caps: ['device-run'] });
    await expect(devices.request('arch', { kind: 'screenshot', payload: {} }, { why: 'x' })).rejects.toThrow('No device called "arch" (connected: m1arch)');
    await expect(devices.request('M1ARCH', { kind: 'screenshot', payload: {} }, { why: 'x' })).rejects.toThrow("m1arch doesn't let agents take screenshots");
  });

  it('caps output at 64 KB, and only the asked screen settles a request', async () => {
    const { devices, sent } = make();
    devices.offer('a', box);
    devices.offer('b', { ...box, name: 'other' });
    const done = devices.request('m1arch', { kind: 'run', payload: { command: 'yes' } }, { why: 'x' });
    const id = sent[0]!.id;
    expect(devices.settle('b', id, { outcome: 'ok', exitCode: 0 })).toBe(false);
    expect(devices.settle('a', id, { outcome: 'ok', exitCode: 0, stdout: 'y'.repeat(100_000) })).toBe(true);
    const result = await done;
    expect(result.stdout?.startsWith('y'.repeat(64 * 1024))).toBe(true);
    expect(result.stdout?.endsWith('(cut at 64 KB)')).toBe(true);
  });

  it('refuses an uploaded path outside the uploads folder', async () => {
    const { devices, sent } = make();
    devices.offer('a', box);
    const done = devices.request('m1arch', { kind: 'file', payload: { path: '~/notes.txt' } }, { why: 'x' });
    devices.settle('a', sent[0]!.id, { outcome: 'ok', path: '/etc/passwd' });
    expect(await done).toEqual({ outcome: 'error', error: 'The device sent a file outside the uploads folder' });
  });
});

describe('device requests through the daemon, with a fake remote app', () => {
  it('runs a command and brings back its exit code and output', async () => {
    const { daemon, port } = await startDaemon();
    const screen = await connect(port, { device: box });
    const done = daemon.devices.request('m1arch', { kind: 'run', payload: { command: 'uname -a', cwd: '~' } }, { timeoutSec: 20, conversation: 'c1', agent: 'claude', why: 'which kernel' });
    await waitFor(() => screen.requests.length === 1);
    const req = screen.requests[0]!;
    expect(req).toMatchObject({ t: 'device_request', kind: 'run', payload: { command: 'uname -a', cwd: '~' }, timeoutSec: 20, conversation: 'c1', agent: 'claude', why: 'which kernel' });
    screen.answer({ t: 'device_result', id: req.id, outcome: 'ok', exitCode: 0, stdout: 'Linux m1arch\n', stderr: '' });
    expect(await done).toEqual({ outcome: 'ok', exitCode: 0, stdout: 'Linux m1arch\n', stderr: '' });
  });

  it('brings back where a file and a screenshot were uploaded', async () => {
    const { daemon, port } = await startDaemon();
    const screen = await connect(port, { device: box });
    const file = daemon.devices.request('m1arch', { kind: 'file', payload: { path: '~/notes.txt' } }, { why: 'read notes' });
    const shot = daemon.devices.request('m1arch', { kind: 'screenshot', payload: {} }, { why: 'see the error' });
    await waitFor(() => screen.requests.length === 2);
    const [fileReq, shotReq] = screen.requests;
    screen.answer({ t: 'device_result', id: fileReq!.id, outcome: 'ok', path: `${UPLOADS}/2026-11-08/ab/notes.txt` });
    screen.answer({ t: 'device_result', id: shotReq!.id, outcome: 'ok', path: `${UPLOADS}/2026-11-08/cd/screen.png` });
    expect(await file).toEqual({ outcome: 'ok', path: `${UPLOADS}/2026-11-08/ab/notes.txt` });
    expect(await shot).toEqual({ outcome: 'ok', path: `${UPLOADS}/2026-11-08/cd/screen.png` });
  });

  it('passes on a refusal from the person at the device', async () => {
    const { daemon, port } = await startDaemon();
    const screen = await connect(port, { device: box });
    const done = daemon.devices.request('m1arch', { kind: 'run', payload: { command: 'rm -rf ~/tmp' } }, { why: 'clean up' });
    await waitFor(() => screen.requests.length === 1);
    screen.answer({ t: 'device_result', id: screen.requests[0]!.id, outcome: 'refused' });
    expect(await done).toEqual({ outcome: 'refused' });
  });

  it('fails at once with "device disconnected" when the screen drops', async () => {
    const { daemon, port } = await startDaemon();
    const screen = await connect(port, { device: box });
    const done = daemon.devices.request('m1arch', { kind: 'screenshot', payload: {} }, { timeoutSec: 600, why: 'look' });
    await waitFor(() => screen.requests.length === 1);
    screen.drop();
    await expect(done).rejects.toThrow('device disconnected');
    expect(daemon.devices.list()).toEqual([]);
  });

  it('times out when the device never answers', async () => {
    const { daemon, port } = await startDaemon(0);
    const screen = await connect(port, { device: box });
    const done = daemon.devices.request('m1arch', { kind: 'run', payload: { command: 'sleep 99' } }, { timeoutSec: 1, why: 'wait' });
    await waitFor(() => screen.requests.length === 1);
    await expect(done).rejects.toThrow("m1arch didn't answer within 1s");
  });

  it('offers only remote apps with device caps, and devices.list shows name, OS, caps and last seen', async () => {
    const { daemon, session, port } = await startDaemon();
    await connect(port, { kind: 'test', device: { ...box, name: 'a-test-screen' } });
    await connect(port, { device: { ...box, name: 'no-caps', caps: [] } });
    await connect(port, { caps: ['notify'] });
    const before = Date.now();
    await connect(port, { device: { name: 'mbp', os: 'macos', caps: ['device-screenshot'] } });
    await waitFor(() => daemon.clients.size === 4);
    expect(devicesOf(session)).toBe(daemon.devices);
    const listed = DEVICES_HANDLERS['devices.list'](session as never);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'mbp', os: 'macos', caps: ['device-screenshot'] });
    expect(listed[0]!.lastSeen).toBeGreaterThanOrEqual(before);
  });
});
