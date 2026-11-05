import { repeat } from './repeat.js';

/**
 * How loud each person in a call is right now (BLG-706): one analyser per voice, read by the
 * speaking rings on every animation frame, so the rings move with the voice without React drawing
 * anything. Who is speaking (a voice over the threshold for a moment) is said only when it changes.
 */

/** A level (0…1) above this for `HOLD_MS` is speaking; below it for as long, it stopped. */
const SPEAKING = 0.045;
const HOLD_MS = 220;
const POLL_MS = 60;

interface Meter {
  readonly read: () => number;
  readonly dispose: () => void;
  level: number;
  since: number;
  speaking: boolean;
}

export class Levels {
  private ctx: AudioContext | undefined;
  private readonly meters = new Map<string, Meter>();
  private stopTimer: (() => void) | undefined;

  constructor(private readonly onSpeaking: (who: ReadonlySet<string>) => void) {}

  /** Measure this person's voice (their stream, or yours). */
  watch(peerId: string, stream: MediaStream): void {
    this.forget(peerId);
    if (!stream.getAudioTracks().length) return;
    this.ctx ??= new AudioContext();
    const source = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const read = (): number => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    };
    this.add(peerId, read, () => source.disconnect());
  }

  /** The demo: a made-up voice (a function of time). */
  pretend(peerId: string, level: () => number): void {
    this.forget(peerId);
    this.add(peerId, level, () => undefined);
  }

  forget(peerId: string): void {
    this.meters.get(peerId)?.dispose();
    this.meters.delete(peerId);
    if (!this.meters.size) {
      this.stopTimer?.();
      this.stopTimer = undefined;
    }
  }

  /** 0…1, for drawing. */
  level(peerId: string): number {
    return this.meters.get(peerId)?.level ?? 0;
  }

  stop(): void {
    for (const id of [...this.meters.keys()]) this.forget(id);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
  }

  private add(peerId: string, read: () => number, dispose: () => void): void {
    this.meters.set(peerId, { read, dispose, level: 0, since: 0, speaking: false });
    this.run();
  }

  private run(): void {
    if (this.stopTimer) return;
    let said = '';
    this.stopTimer = repeat(() => {
      const now = performance.now();
      for (const m of this.meters.values()) {
        m.level = m.level * 0.5 + m.read() * 0.5;
        const loud = m.level > SPEAKING;
        if (loud === m.speaking) {
          m.since = 0;
          continue;
        }
        if (!m.since) m.since = now;
        if (now - m.since > HOLD_MS) {
          m.speaking = loud;
          m.since = 0;
        }
      }
      const who = [...this.meters].filter(([, m]) => m.speaking).map(([id]) => id);
      const key = [...who].sort().join(',');
      if (key !== said) {
        said = key;
        this.onSpeaking(new Set(who));
      }
    }, POLL_MS);
  }
}
