import type { DeviceCap, DeviceOffer, DeviceOs, DeviceRequestFrame, DeviceResult } from '../../../../src/shared/devices.js';
import { appInvoke, remoteApp } from './boot-mode.js';

/**
 * Device reach (BLG-56): the app as a client offers its own machine to the server's agents. This
 * side only carries frames: each request goes to the app shell (src-tauri/src/device.rs), which
 * asks the person here in a window of its own and does the work; what it answers goes back as is.
 * Nothing here can approve anything.
 */

/** What this app does so far. */
export const DEVICE_CAPS_OFFERED: readonly DeviceCap[] = ['device-run'];

export const deviceOs = (userAgent: string): DeviceOs => {
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'macos';
  if (/Windows/.test(userAgent)) return 'windows';
  return 'linux';
};

type ClientView = { readonly deviceName: string };

type Invoke = <T>(cmd: 'client_config' | 'device_run', args?: Record<string, unknown>) => Promise<T>;

const unsupported = (request: DeviceRequestFrame): DeviceResult => ({ outcome: 'error', error: `This device can't do ${request.kind} requests yet` });

/** Hand one request to the app shell and bring back its answer. */
export const handleDeviceRequest = async (request: DeviceRequestFrame, invoke: Invoke = appInvoke): Promise<DeviceResult> => {
  if (request.kind !== 'run') return unsupported(request);
  return invoke<DeviceResult>('device_run', { request });
};

/** What the hello offers: only the app as a client of a server, named as in Settings › Server. */
export const deviceOffer = async (invoke: Invoke = appInvoke): Promise<DeviceOffer | undefined> => {
  if (!remoteApp()) return undefined;
  const { deviceName } = await invoke<ClientView>('client_config');
  return { name: deviceName, os: deviceOs(navigator.userAgent), caps: DEVICE_CAPS_OFFERED };
};

/** The socket's device option, or nothing outside the app as a client. */
export const deviceReach = async (): Promise<{ readonly offer: DeviceOffer; readonly handle: (request: DeviceRequestFrame) => Promise<DeviceResult> } | undefined> => {
  const offer = await deviceOffer().catch(() => undefined);
  return offer ? { offer, handle: (request) => handleDeviceRequest(request) } : undefined;
};
