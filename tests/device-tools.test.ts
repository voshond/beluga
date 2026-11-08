import { describe, expect, it } from 'vitest';
import { DEVICE_TOOL_NAMES, createDeviceToolDefs } from '../src/agent/device-tools.js';
import { createRoomTools } from '../src/agent/tools.js';
import { decideTool } from '../src/agent/policy.js';
import { buildSystemAppend } from '../src/agent/prompt.js';
import { deviceBridge } from '../src/core/agent-bridge.js';
import { Devices, attachDevices } from '../src/core/devices/index.js';
import { CLAUDE_AGENT } from '../src/protocol.js';
import type { RoomBridge } from '../src/agent/types.js';
import type { DeviceRequestFrame, DeviceResult } from '../src/shared/devices.js';

const UPLOADS = '/srv/beluga/uploads';

const baseBridge: RoomBridge = {
  selfName: () => 'kay',
  sendChat: () => undefined,
  listPeers: () => [],
  askAgent: async () => '',
  listPeerFiles: async () => [],
  readPeerFile: async () => '',
  writeReport: async () => '',
  reportUsage: () => undefined,
  getPeerFile: async () => '',
  sendFile: async () => '',
};

type Handler = (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** A daemon's devices with one fake remote app that answers each request with `answer`. */
const withDevice = (answer: (f: DeviceRequestFrame) => DeviceResult, caps: Array<'device-run' | 'device-file' | 'device-screenshot'> = ['device-run', 'device-file', 'device-screenshot']) => {
  const sent: DeviceRequestFrame[] = [];
  const devices: Devices = new Devices({
    uploadsRoot: UPLOADS,
    send: (clientId, frame) => {
      sent.push(frame);
      queueMicrotask(() => devices.settle(clientId, frame.id, answer(frame)));
    },
  });
  devices.offer('screen-1', { name: 'm1arch', os: 'linux', caps });
  const session = { agentRef: CLAUDE_AGENT, host: { currentChannel: 'room' } };
  attachDevices(session, devices);
  const defs = createDeviceToolDefs({ ...baseBridge, devices: deviceBridge(session as never, 'conv-1') });
  const call = (name: string, args: Record<string, unknown>) => (defs.find((d) => d.name === name)!.handler as Handler)(args, {});
  return { sent, call };
};

describe('device tools', () => {
  it('appear in the Beluga MCP tool list', () => {
    const names = createRoomTools(baseBridge).tools.map((t) => `mcp__beluga__${t.name}`);
    expect(names).toEqual(expect.arrayContaining(DEVICE_TOOL_NAMES));
    expect(DEVICE_TOOL_NAMES).toEqual(['mcp__beluga__list_devices', 'mcp__beluga__run_on_device', 'mcp__beluga__get_device_file', 'mcp__beluga__device_screenshot']);
  });

  it('say clearly when no device is connected or the name is unknown', async () => {
    const bare = createDeviceToolDefs(baseBridge);
    const list = await (bare.find((d) => d.name === 'list_devices')!.handler as Handler)({}, {});
    expect(list.content[0]!.text).toMatch(/^No client device is connected/);
    const shot = await (bare.find((d) => d.name === 'device_screenshot')!.handler as Handler)({ device: 'm1arch', why: 'look' }, {});
    expect(shot.isError).toBe(true);
    expect(shot.content[0]!.text).toMatch(/^No client device is connected/);

    const empty = createDeviceToolDefs({ ...baseBridge, devices: deviceBridge({ agentRef: CLAUDE_AGENT, host: { currentChannel: 'room' } } as never) });
    const none = await (empty.find((d) => d.name === 'run_on_device')!.handler as Handler)({ device: 'm1arch', command: 'ls', why: 'look' }, {});
    expect(none).toMatchObject({ isError: true, content: [{ text: 'No client device is connected' }] });

    const { call } = withDevice(() => ({ outcome: 'ok' }));
    const unknown = await call('device_screenshot', { device: 'arch', why: 'look' });
    expect(unknown).toMatchObject({ isError: true, content: [{ text: 'No device called "arch" (connected: m1arch)' }] });
  });

  it('list devices with name, OS, what they allow and last seen', async () => {
    const { call } = withDevice(() => ({ outcome: 'ok' }), ['device-run', 'device-screenshot']);
    const listed = JSON.parse((await call('list_devices', {})).content[0]!.text);
    expect(listed).toEqual([{ name: 'm1arch', os: 'linux', allows: ['run', 'screenshot'], last_seen: expect.any(String) }]);
  });

  it('refuse secrets before anything reaches the client', async () => {
    const { sent, call } = withDevice(() => ({ outcome: 'ok', exitCode: 0 }));
    for (const [name, args] of [
      ['run_on_device', { device: 'm1arch', command: 'cat ~/.ssh/id_ed25519', why: 'x' }],
      ['run_on_device', { device: 'm1arch', command: 'cat ".e"nv', why: 'x' }],
      ['run_on_device', { device: 'm1arch', command: 'ls', cwd: '~/.aws', why: 'x' }],
      ['get_device_file', { device: 'm1arch', path: '~/project/.env', why: 'x' }],
      ['get_device_file', { device: 'm1arch', path: '~/.ssh/id_rsa', why: 'x' }],
    ] as const) {
      const result = await call(name, args);
      expect(result, `${name} ${JSON.stringify(args)}`).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/never asks a device for secrets/) }] });
    }
    expect(sent).toEqual([]);
  });

  it('run a command and bring back its exit code and output, with who asked and why', async () => {
    const { sent, call } = withDevice(() => ({ outcome: 'ok', exitCode: 2, stdout: 'out', stderr: 'err' }));
    const result = await call('run_on_device', { device: 'M1ARCH', command: 'make test', cwd: '~/src', timeout_sec: 30, why: 'run the tests' });
    expect(result.content[0]!.text).toBe('Exit code: 2\n--- stdout ---\nout\n--- stderr ---\nerr');
    expect(sent[0]).toMatchObject({ kind: 'run', payload: { command: 'make test', cwd: '~/src' }, timeoutSec: 30, why: 'run the tests', conversation: 'conv-1', agent: expect.stringMatching(/Claude/) });
  });

  it('bring back where a file and a screenshot were saved', async () => {
    const { call } = withDevice((f) => ({ outcome: 'ok', path: `${UPLOADS}/d/${f.kind === 'file' ? 'notes.txt' : 'screen.png'}` }));
    expect((await call('get_device_file', { device: 'm1arch', path: '~/notes.txt', why: 'read it' })).content[0]!.text).toBe(`Saved here: ${UPLOADS}/d/notes.txt`);
    expect((await call('device_screenshot', { device: 'm1arch', why: 'see it' })).content[0]!.text).toMatch(`Screenshot saved here: ${UPLOADS}/d/screen.png`);
  });

  it('report a refusal as final, and a device error as an error', async () => {
    const refused = withDevice(() => ({ outcome: 'refused' }));
    expect(await refused.call('device_screenshot', { device: 'm1arch', why: 'see it' })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/refused this request\. That is final/) }] });
    const failed = withDevice(() => ({ outcome: 'error', error: 'screenshots are not supported on Windows yet' }));
    expect(await failed.call('device_screenshot', { device: 'm1arch', why: 'see it' })).toMatchObject({ isError: true, content: [{ text: "m1arch couldn't do it: screenshots are not supported on Windows yet" }] });
  });
});

describe('device tools in the policy', () => {
  const ctx = { cwd: '/work/proj', roots: ['/work/proj'], autoEdit: false };

  it('never auto-approves a request to a device; secrets are denied; listing is fine', () => {
    expect(decideTool('mcp__beluga__run_on_device', { device: 'm1arch', command: 'ls', why: 'x' }, ctx)).toBe('ask');
    expect(decideTool('mcp__beluga__run_on_device', { device: 'm1arch', command: 'ls', why: 'x' }, { ...ctx, scope: 'full' })).toBe('ask');
    expect(decideTool('mcp__beluga__get_device_file', { device: 'm1arch', path: '~/a.txt', why: 'x' }, ctx)).toBe('ask');
    expect(decideTool('mcp__beluga__device_screenshot', { device: 'm1arch', why: 'x' }, ctx)).toBe('ask');
    expect(decideTool('mcp__beluga__run_on_device', { command: 'cat .env', why: 'x' }, ctx)).toBe('deny');
    expect(decideTool('mcp__beluga__get_device_file', { path: '~/.ssh/id_rsa', why: 'x' }, ctx)).toBe('deny');
    expect(decideTool('mcp__beluga__list_devices', {}, ctx)).toBe('allow');
    expect(decideTool('mcp__beluga__device_screenshot', {}, { ...ctx, guest: true })).toBe('deny');
  });
});

describe('the agent prompt', () => {
  it('explains when to use the user’s own client devices', () => {
    const prompt = buildSystemAppend('kay');
    expect(prompt).toContain("The user's own client devices (list_devices, run_on_device, get_device_file, device_screenshot)");
    expect(prompt).toContain('Use them only when the work needs something on that box');
    expect(prompt).toContain('The person at the device approves every request');
    expect(prompt).toContain('a refusal is final');
  });
});

describe('device steps in words', () => {
  it('say what was done on which device', async () => {
    const { humanizeTool } = await import('../src/shared/step-titles.js');
    expect(humanizeTool('mcp__beluga__run_on_device', { device: 'm1arch', command: 'uname -a' }).done).toBe('Ran on m1arch: uname -a');
    expect(humanizeTool('mcp__beluga__get_device_file', { device: 'm1arch', path: '~/notes.txt' }).done).toBe('Got notes.txt from m1arch');
    expect(humanizeTool('mcp__beluga__device_screenshot', { device: 'm1arch' }).doing).toBe('Taking a screenshot of m1arch');
    expect(humanizeTool('mcp__beluga__list_devices', {}).done).toBe('Looked at your connected devices');
  });
});
