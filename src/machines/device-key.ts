import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { type DeviceKeys, deviceKeys, fromHex, hex, newSeed } from '../companion/device-crypto.js';
import { writeJson } from '../net/mesh/files.js';

/**
 * This install's own device key (BLG-774): one 32-byte seed in ~/.beluga/device-key.json (0600),
 * made the first time it's needed. Its device, link and box keys come from it as a phone's do
 * (device-crypto.ts `deviceKeys`), so an app or a computer is a device of yours like a phone.
 */

const KeyFile = z.object({ v: z.literal(1), seed: z.string().regex(/^[0-9a-f]{64}$/) });

export function loadDeviceKeys(file: string): DeviceKeys {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`This computer's device key (${file}) can't be read; move it aside to make a new one`);
  }
  if (raw !== undefined) {
    const parsed = KeyFile.safeParse(raw);
    if (!parsed.success) throw new Error(`This computer's device key (${file}) is damaged; move it aside to make a new one`);
    return deviceKeys(fromHex(parsed.data.seed));
  }
  const seed = newSeed();
  writeJson(file, { v: 1, seed: hex(seed) });
  return deviceKeys(seed);
}
