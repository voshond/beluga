/**
 * Camera sizes (BLG-717): each viewer says how big it shows a camera, and the sender sends it so.
 * Pure (tests read it from the root).
 */

/** How someone shows your camera (BLG-717): big (face to face, a small collage), small (a tile), or not at all. */
export type CameraSize = 'big' | 'small' | 'none';

/**
 * Your camera for one person: as big as they show it, within what your upload can carry
 * (`budget`, kbit/s, your share of it for this line). Not shown: nothing is sent at all.
 */
export function cameraEncoding(size: CameraSize, budget?: number): { readonly maxBitrate: number; readonly scaleResolutionDownBy: number; readonly active: boolean } {
  if (size === 'none') return { maxBitrate: 50_000, scaleResolutionDownBy: 4, active: false };
  const want = size === 'big' ? 1_800 : 350;
  const kbps = Math.max(150, Math.min(want, budget ?? want));
  // Fewer pixels when there's less to send them with: sharp small beats blurry big.
  const scale = kbps >= 1_200 ? 1 : kbps >= 600 ? 1.5 : kbps >= 300 ? 2 : 3;
  return { maxBitrate: kbps * 1000, scaleResolutionDownBy: scale, active: true };
}

