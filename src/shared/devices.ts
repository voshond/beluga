/**
 * Client devices: a remote app's own machine, offered to the server's agents for a command, a file
 * or a screenshot, each approved at that machine. Browser-safe.
 */

export const DEVICE_CAPS = ['device-run', 'device-file', 'device-screenshot'] as const;
export type DeviceCap = (typeof DEVICE_CAPS)[number];

export const DEVICE_OS = ['linux', 'macos', 'windows'] as const;
export type DeviceOs = (typeof DEVICE_OS)[number];

export const DEVICE_KINDS = ['run', 'file', 'screenshot'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const CAP_OF: Readonly<Record<DeviceKind, DeviceCap>> = { run: 'device-run', file: 'device-file', screenshot: 'device-screenshot' };

export const DEVICE_TIMEOUT_DEFAULT_SEC = 120;
export const DEVICE_TIMEOUT_MAX_SEC = 600;
/** Time on top of a request's own timeout for the person at the device to approve it. */
export const DEVICE_APPROVAL_GRACE_SEC = 30;
/** Most of each output stream that comes back. */
export const DEVICE_OUTPUT_CAP_BYTES = 64 * 1024;

/** What a screen says about its machine in its hello. */
export type DeviceOffer = { readonly name: string; readonly os: DeviceOs; readonly caps: readonly DeviceCap[] };

/** A device as the API and the agents see it (its id is its screen's). */
export type DeviceInfo = DeviceOffer & { readonly id: string; readonly lastSeen: number };

export type DeviceAsk =
  | { readonly kind: 'run'; readonly payload: { readonly command: string; readonly cwd?: string } }
  | { readonly kind: 'file'; readonly payload: { readonly path: string } }
  | { readonly kind: 'screenshot'; readonly payload: Readonly<Record<string, never>> };

/** Who asked, and why: shown at the device with the request. */
export type DeviceAskMeta = { readonly timeoutSec?: number; readonly conversation?: string; readonly agent?: string; readonly why: string };

/** Daemon → screen: do this on your machine once the person there approves it. */
export type DeviceRequestFrame = DeviceAsk & {
  readonly t: 'device_request';
  readonly id: string;
  readonly timeoutSec: number;
  readonly conversation?: string;
  readonly agent?: string;
  readonly why: string;
};

export type DeviceOutcome = 'ok' | 'refused' | 'error';

/** How a request ended at the device: a command's exit code and output, or where a file or screenshot was uploaded. */
export type DeviceResult = {
  readonly outcome: DeviceOutcome;
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly path?: string;
  readonly error?: string;
};
