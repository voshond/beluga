import type { DeviceCap, DeviceOffer, DeviceOs, DeviceRequestFrame, DeviceResult } from '../../../../src/shared/devices.js';
import { appInvoke, remoteApp } from './boot-mode.js';

/**
 * Device reach (BLG-56, BLG-57): the app as a client offers its own machine to the server's
 * agents. This side only carries frames: each request goes to the app shell
 * (src-tauri/src/device.rs), which asks the person here in a window of its own and does the work.
 * A command's answer goes back as is; a file's or a screenshot's bytes are uploaded to the server
 * (its /upload, same origin) and its path there goes back. Nothing here can approve anything.
 */

type DeviceCommand = 'client_config' | 'device_run' | 'device_file' | 'device_screenshot';
type Invoke = <T>(cmd: DeviceCommand, args?: Record<string, unknown>) => Promise<T>;
/** Send a file to the server (lib/web-files.ts: uploadFile): where it landed there. */
export type Upload = (file: File) => Promise<{ readonly path: string }>;

export type DeviceReach = { readonly offer: DeviceOffer; readonly handle: (request: DeviceRequestFrame) => Promise<DeviceResult> };

/** What this app does on each OS: Windows has no screenshots yet. */
export const deviceCaps = (os: DeviceOs): readonly DeviceCap[] => (os === 'windows' ? ['device-run', 'device-file'] : ['device-run', 'device-file', 'device-screenshot']);

export const deviceOs = (userAgent: string): DeviceOs => {
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'macos';
  if (/Windows/.test(userAgent)) return 'windows';
  return 'linux';
};

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'file';

const stamp = (now: Date): string => now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/** A refusal or error from the shell comes back as its result; anything else thrown is an error. */
const asResult = (err: unknown): DeviceResult => {
  if (typeof err === 'object' && err !== null && 'outcome' in err) return err as DeviceResult;
  return { outcome: 'error', error: err instanceof Error ? err.message : String(err) };
};

/** Hand one request to the app shell and bring back its answer. */
export const handleDeviceRequest = async (request: DeviceRequestFrame, invoke: Invoke, upload: Upload, now = () => new Date()): Promise<DeviceResult> => {
  try {
    if (request.kind === 'run') return await invoke<DeviceResult>('device_run', { request });
    const [cmd, name] = request.kind === 'file' ? (['device_file', baseName(request.payload.path)] as const) : (['device_screenshot', `screenshot-${stamp(now())}.png`] as const);
    const bytes = await invoke<ArrayBuffer>(cmd, { request });
    const sent = await upload(new File([bytes], name, { type: request.kind === 'screenshot' ? 'image/png' : 'application/octet-stream' }));
    return { outcome: 'ok', path: sent.path };
  } catch (err) {
    return asResult(err);
  }
};

/** What the hello offers: only the app as a client of a server, named as in Settings › Server. */
export const deviceOffer = async (invoke: Invoke = appInvoke): Promise<DeviceOffer | undefined> => {
  if (!remoteApp()) return undefined;
  const { deviceName } = await invoke<{ readonly deviceName: string }>('client_config');
  const os = deviceOs(navigator.userAgent);
  return { name: deviceName, os, caps: deviceCaps(os) };
};

/** The socket's device option, or nothing outside the app as a client. */
export const deviceReach = async (upload: Upload): Promise<DeviceReach | undefined> => {
  const offer = await deviceOffer().catch(() => undefined);
  return offer ? { offer, handle: (request) => handleDeviceRequest(request, appInvoke, upload) } : undefined;
};
