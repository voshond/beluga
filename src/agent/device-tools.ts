import { z } from 'zod';
import { tool } from './tool-kit.js';
import { mentionsSecret } from './policy.js';
import { isSecretPath } from '../core/shares.js';
import { DEVICE_TIMEOUT_MAX_SEC, type DeviceAsk, type DeviceInfo, type DeviceResult } from '../shared/devices.js';
import type { RoomBridge } from './types.js';

/**
 * Your Claude's tools for the user's own client devices (core/devices): the desktop apps connected
 * to this Beluga as a server. Each request is approved by the person at that device; secrets are
 * refused here, before anything reaches it.
 */

/** What these tools need from Beluga (see core/agent-bridge.ts). */
export type DeviceBridge = {
  list(): readonly DeviceInfo[];
  request(device: string, ask: DeviceAsk, meta: { readonly timeoutSec?: number; readonly why: string }): Promise<DeviceResult>;
};

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function guarded(fn: () => Promise<string> | string): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

export const DEVICE_TOOL_NAMES = ['list_devices', 'run_on_device', 'get_device_file', 'device_screenshot'].map((n) => `mcp__beluga__${n}`);

const SECRET_REFUSED = 'Beluga never asks a device for secrets (.env files, keys, credentials)';
const NONE = "No client device is connected. A device is the user's own desktop app connected to this Beluga as a server (Connect to a server).";

const ALLOWS: Readonly<Record<DeviceInfo['caps'][number], string>> = { 'device-run': 'run', 'device-file': 'file', 'device-screenshot': 'screenshot' };

const deviceArg = z.string().min(1).max(100).describe('The device’s name (from list_devices)');
const whyArg = z.string().min(1).max(500).describe('One line shown to the person at the device when they approve it');

/** What came back, in words; a refusal or an error is the tool's error. */
const answered = (device: string, result: DeviceResult, ok: (r: DeviceResult) => string): string => {
  if (result.outcome === 'refused') throw new Error(`The person at ${device} refused this request. That is final: tell the user, and don't ask again for the same thing.`);
  if (result.outcome === 'error') throw new Error(`${device} couldn't do it: ${result.error ?? 'unknown error'}`);
  return ok(result);
};

const ran = (r: DeviceResult): string =>
  [`Exit code: ${r.exitCode ?? 'none (stopped)'}`, ...(r.stdout ? ['--- stdout ---', r.stdout] : []), ...(r.stderr ? ['--- stderr ---', r.stderr] : [])].join('\n');

export function createDeviceToolDefs(bridge: RoomBridge) {
  const devices = (): DeviceBridge => {
    if (!bridge.devices) throw new Error(NONE);
    return bridge.devices;
  };
  return [
    tool(
      'list_devices',
      "The user's own client devices connected right now (their desktop app connected to this Beluga as a server): name, OS, what each allows (run, file, screenshot) and when it was last seen. Check it before the other device tools.",
      {},
      () =>
        guarded(() => {
          const all = devices().list();
          if (!all.length) return NONE;
          return JSON.stringify(all.map((d) => ({ name: d.name, os: d.os, allows: d.caps.map((c) => ALLOWS[c]), last_seen: new Date(d.lastSeen).toISOString() })), null, 2);
        }),
    ),
    tool(
      'run_on_device',
      "Run one shell command on one of the user's own client devices (the box they're sitting at), in its login shell with no input. The person there approves it first; a refusal is final. Waits for the exit code, stdout and stderr (each cut at 64 KB). Commands touching secrets are refused.",
      {
        device: deviceArg,
        command: z.string().min(1).max(8000),
        cwd: z.string().max(4096).optional().describe('Folder on the device (~ is its home)'),
        timeout_sec: z.number().int().min(1).max(DEVICE_TIMEOUT_MAX_SEC).optional().describe('Stop it after this long (default 120); approving it doesn’t count'),
        why: whyArg,
      },
      (a) =>
        guarded(async () => {
          if (mentionsSecret(a.command) || (a.cwd && isSecretPath(a.cwd))) throw new Error(SECRET_REFUSED);
          const ask: DeviceAsk = { kind: 'run', payload: { command: a.command, ...(a.cwd ? { cwd: a.cwd } : {}) } };
          const result = await devices().request(a.device, ask, { why: a.why, ...(a.timeout_sec ? { timeoutSec: a.timeout_sec } : {}) });
          return answered(a.device, result, ran);
        }),
    ),
    tool(
      'get_device_file',
      "Copy one file from one of the user's own client devices to this computer (into ~/.beluga/uploads). The person there approves it first; a refusal is final. Returns where it was saved here. Secrets are refused.",
      { device: deviceArg, path: z.string().min(1).max(4096).describe('The full path of the file on the device (~ is its home)'), why: whyArg },
      (a) =>
        guarded(async () => {
          if (isSecretPath(a.path)) throw new Error(SECRET_REFUSED);
          const result = await devices().request(a.device, { kind: 'file', payload: { path: a.path } }, { why: a.why });
          return answered(a.device, result, (r) => `Saved here: ${r.path}`);
        }),
    ),
    tool(
      'device_screenshot',
      "Take a screenshot of one of the user's own client devices (what they see on that box) and bring it to this computer (into ~/.beluga/uploads). The person there approves it first; a refusal is final. Returns the image's path: Read it to look.",
      { device: deviceArg, why: whyArg },
      (a) =>
        guarded(async () => {
          const result = await devices().request(a.device, { kind: 'screenshot', payload: {} }, { why: a.why });
          return answered(a.device, result, (r) => `Screenshot saved here: ${r.path} (Read it to look at it)`);
        }),
    ),
  ];
}
