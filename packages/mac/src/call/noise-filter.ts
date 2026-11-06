import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorklet from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

/**
 * Background noise out of your voice in a call (BLG-744), on unless you turn it off for the call.
 * WebKit ignores a page's `noiseSuppression`, and macOS's Voice Isolation is only the user's to
 * pick (no app may turn it on), so the call does its own: RNNoise (xiph/rnnoise, a small neural
 * network made for this, via @sapphi-red/web-noise-suppressor) in an audio worklet between your
 * microphone and the call. Typing, fans, a street: out; your voice: kept. It adds about 10 ms.
 *
 * The call gets one track from here for as long as the microphone is on: turning the filter off
 * and on rewires what feeds it, so nobody's line is renegotiated. If the audio engine can't start,
 * or stops later, the call is told (`broken`) and goes back to the plain microphone: a voice
 * without the filter beats no voice.
 */

/** The model's binary, fetched once per window (the faster one where WebKit has SIMD). */
let wasm: Promise<ArrayBuffer> | undefined;

/** How long the audio engine may take to start before the plain microphone is used instead. */
const START_MS = 1_500;

export class NoiseFilter {
  /** What the call sends: your voice, cleaned (or as is, while off). */
  readonly stream: MediaStream;
  private on = true;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly node: RnnoiseWorkletNode,
    private readonly out: MediaStreamAudioDestinationNode,
  ) {
    this.stream = out.stream;
    source.connect(node);
    node.connect(out);
  }

  /** The filter over this microphone, or undefined if this window can't run it (the call uses the microphone as is). */
  static async start(mic: MediaStream, broken: () => void): Promise<NoiseFilter | undefined> {
    if (!mic.getAudioTracks().length || typeof AudioWorkletNode === 'undefined') return undefined;
    let ctx: AudioContext | undefined;
    try {
      // RNNoise works at 48 kHz: the context runs at it, so nothing is resampled in between.
      ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
      wasm ??= loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm }).catch((err: unknown) => {
        wasm = undefined;
        throw err;
      });
      const [binary] = await Promise.all([wasm, ctx.audioWorklet.addModule(rnnoiseWorklet)]);
      const node = new RnnoiseWorkletNode(ctx, { wasmBinary: binary, maxChannels: 1 });
      const filter = new NoiseFilter(ctx, ctx.createMediaStreamSource(mic), node, ctx.createMediaStreamDestination());
      if (!(await running(ctx))) throw new Error('The audio engine didn’t start');
      // Stopped later (the Mac slept, the device went): one try to go on, else back to the plain microphone.
      const c = ctx;
      c.onstatechange = () => {
        if (c.state === 'closed' || c.state === 'running') return;
        void running(c).then((ok) => !ok && broken());
      };
      return filter;
    } catch {
      void ctx?.close().catch(() => undefined);
      return undefined;
    }
  }

  get enabled(): boolean {
    return this.on;
  }

  /** On: through the filter. Off: straight through, the same track to the call. */
  set enabled(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    this.source.disconnect();
    this.source.connect(on ? this.node : this.out);
  }

  stop(): void {
    this.ctx.onstatechange = null;
    this.source.disconnect();
    this.node.disconnect();
    this.node.destroy();
    for (const t of this.stream.getTracks()) t.stop();
    void this.ctx.close().catch(() => undefined);
  }
}

/** The context is running, or starts within a moment. */
async function running(ctx: AudioContext): Promise<boolean> {
  if (ctx.state === 'running') return true;
  await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, START_MS))]);
  return (ctx.state as AudioContextState) === 'running';
}
