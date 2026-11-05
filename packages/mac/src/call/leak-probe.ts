/**
 * Is the sharer's overlay in what they share (BLG-736)? The overlay asks macOS to be left out of
 * screen captures, but since macOS 15 ScreenCaptureKit doesn't always listen. If it's in the
 * picture, the others see their own pointers and ink twice: theirs, and the overlay's copy, late.
 *
 * So the overlay shows a few pixels of a colour nothing else uses in its top-left corner (under the
 * screen's rounded corner, where nobody sees them), and the sharer's window looks for them in its
 * own capture of the screen. Two colours in turn, both found: the overlay is in the picture.
 */

/** The two colours, shown in turn (one could be on screen by chance; both, in turn, can't). */
export const PROBE_COLORS = ['#ff00fe', '#00fffe'] as const;
/** How big the probe is (CSS pixels, from the top-left corner). */
export const PROBE_PX = 4;
/** How close a captured colour must be (per channel, 0…255: the capture converts colours a little). */
const NEAR = 64;
/** Found this many times in a row: in the picture. Not found this many times: out of it. */
export const HITS_TO_LEAK = 2;
export const MISSES_TO_CLEAN = 4;
/** Readings that came back empty (no frame yet) before giving up and trusting macOS. */
export const BLANKS_TO_TRUST = 8;

export type Verdict = 'unknown' | 'clean' | 'leaks';

export interface ProbeState {
  readonly verdict: Verdict;
  readonly hits: number;
  readonly misses: number;
  readonly blanks: number;
  /** How many probes were shown (which colour is next). */
  readonly round: number;
}

export const NEW_PROBE: ProbeState = { verdict: 'unknown', hits: 0, misses: 0, blanks: 0, round: 0 };

const rgb = (hex: string): readonly [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** Whether a captured pixel is the probe's colour. */
export function isProbe(pixel: readonly [number, number, number], hex: string): boolean {
  const want = rgb(hex);
  return pixel.every((v, i) => Math.abs(v - want[i]!) <= NEAR);
}

/** The colour of the probe shown now. */
export const probeColor = (p: ProbeState): string => PROBE_COLORS[p.round % PROBE_COLORS.length]!;

/** What one reading says (`pixel`: the capture's top-left corner, or undefined when there was no frame). */
export function judge(p: ProbeState, pixel: readonly [number, number, number] | undefined): ProbeState {
  if (p.verdict !== 'unknown') return p;
  const round = p.round + 1;
  if (!pixel) {
    const blanks = p.blanks + 1;
    return { ...p, round, blanks, verdict: blanks >= BLANKS_TO_TRUST ? 'clean' : 'unknown' };
  }
  if (isProbe(pixel, probeColor(p))) {
    const hits = p.hits + 1;
    return { ...p, round, hits, misses: 0, verdict: hits >= HITS_TO_LEAK ? 'leaks' : 'unknown' };
  }
  const misses = p.misses + 1;
  return { ...p, round, hits: 0, misses, verdict: misses >= MISSES_TO_CLEAN ? 'clean' : 'unknown' };
}

/** Reads the top-left corner of your own screen capture (before it's encoded, so colours hold). */
export class CornerReader {
  private readonly video = document.createElement('video');
  private readonly canvas = document.createElement('canvas');

  constructor(track: MediaStreamTrack) {
    const v = this.video;
    v.muted = true;
    v.playsInline = true;
    v.srcObject = new MediaStream([track]);
    // Out of sight, but in the page: WebKit only plays what's in it.
    v.style.cssText = 'position:fixed;left:-9999px;top:0;width:8px;height:8px;opacity:0;pointer-events:none';
    document.body.append(v);
    void v.play().catch(() => undefined);
    this.canvas.width = this.canvas.height = 2;
  }

  /** The corner's colour now, or undefined while no frame has come. */
  read(): readonly [number, number, number] | undefined {
    const v = this.video;
    if (!v.videoWidth || !v.videoHeight) return undefined;
    const g = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return undefined;
    // The probe covers PROBE_PX points; the capture may be smaller than the screen: its middle, scaled.
    const screenW = window.screen?.width || v.videoWidth;
    const px = Math.max(1, (PROBE_PX * v.videoWidth) / screenW);
    g.drawImage(v, px * 0.25, px * 0.25, px * 0.5, px * 0.5, 0, 0, 2, 2);
    const d = g.getImageData(0, 0, 2, 2).data;
    const avg = (o: number): number => Math.round((d[o]! + d[o + 4]! + d[o + 8]! + d[o + 12]!) / 4);
    return [avg(0), avg(1), avg(2)];
  }

  stop(): void {
    this.video.srcObject = null;
    this.video.remove();
  }
}
