import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerLinks, type KeptComputers } from '../packages/companion/lib/link/computers.js';
import type { LinkHints, LinkPhase } from '../packages/companion/lib/link/rpc.js';
import { Emitter, type PhaseInfo, type Transport } from '../packages/companion/lib/link/transport.js';
import { COMPANION_PROTO, type MacFrame, type PhoneComputer, type PhoneFrame } from '../src/companion/protocol.js';

/**
 * The phone's link per computer (BLG-809), with fake transports: what your Mac says is linked by
 * itself, a computer added later is dialed at once, one that moved is dialed at its new address,
 * one that went is closed, and while you look a link that dropped is dialed again.
 */

class FakeTransport implements Transport {
  readonly kind = 'bare' as const;
  readonly frames = new Emitter<[MacFrame]>();
  readonly phases = new Emitter<[LinkPhase, string?, PhaseInfo?]>();
  opens: Array<{ hello: PhoneFrame; hints?: LinkHints }> = [];
  sent: PhoneFrame[] = [];
  closed: string[] = [];
  disposed = false;
  constructor(readonly computer: PhoneComputer) {}
  open(hello: PhoneFrame & { t: 'hello' }, hints?: LinkHints): void {
    this.opens.push({ hello, ...(hints ? { hints } : {}) });
    this.phases.emit('dialing');
  }
  close(reason: string): void {
    this.closed.push(reason);
    this.phases.emit('closed');
  }
  send(frame: PhoneFrame): void {
    this.sent.push(frame);
  }
  onFrame(listener: (frame: MacFrame) => void): () => void {
    return this.frames.on(listener);
  }
  onPhase(listener: (phase: LinkPhase, detail?: string, info?: PhaseInfo) => void): () => void {
    return this.phases.on(listener);
  }
  pair(): { cancel(): void } {
    throw new Error('A computer is never paired from here');
  }
  dispose(): void {
    this.disposed = true;
  }
  /** It answers: open, then its welcome. */
  answer(name = this.computer.name): void {
    this.phases.emit('open');
    this.frames.emit({ t: 'welcome', v: { ...COMPANION_PROTO }, min: { ...COMPANION_PROTO }, mac: { name, version: '0.9.0' }, me: { name: 'kayra', peerId: 'me' } });
  }
}

const computer = (n: string, over: Partial<PhoneComputer> = {}): PhoneComputer => ({ id: n.repeat(16), name: `computer ${n}`, platform: 'linux', address: n.repeat(64), relays: [`wss://relay.example/r/${n}`], ...over });

function links(opts: { kept?: KeptComputers; primary?: string; now?: () => number } = {}) {
  const made: FakeTransport[] = [];
  const frames: Array<{ id: string; frame: MacFrame }> = [];
  let saved: KeptComputers | undefined = opts.kept;
  const l = new ComputerLinks({
    make: (c) => {
      const t = new FakeTransport(c);
      made.push(t);
      return t;
    },
    hello: () => ({ t: 'hello', v: { ...COMPANION_PROTO }, app: 'test', platform: 'android', topics: [] }),
    load: () => saved,
    save: (k) => (saved = k),
    onFrame: (id, frame) => frames.push({ id, frame }),
    ...(opts.primary ? { primary: () => opts.primary } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    random: () => 0,
  });
  const of = (id: string) => made.filter((t) => t.computer.id === id).at(-1)!;
  return { l, made, frames, of, kept: () => saved };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('your computers on the phone, each linked by itself', () => {
  it('links each computer your Mac names with its own address and relays, and only while you look', () => {
    const { l, made, of } = links();
    l.setList([computer('1'), computer('2')]);
    // In the background nothing dials.
    expect(made.every((t) => t.opens.length === 0)).toBe(true);
    l.open();
    expect(made).toHaveLength(2);
    expect(of('1'.repeat(16)).opens[0]?.hints).toEqual({ relays: ['wss://relay.example/r/1'], prefer: {} });
    expect(of('1'.repeat(16)).opens[0]?.hello).toMatchObject({ t: 'hello', topics: [] });
    of('1'.repeat(16)).answer('mini');
    expect(l.get('1'.repeat(16))).toMatchObject({ phase: 'open', mac: { name: 'mini' } });
    expect(l.get('2'.repeat(16))?.phase).toBe('dialing');
    // Going away closes every link, saying bye to the open ones.
    l.close('background');
    expect(of('1'.repeat(16)).sent).toEqual([{ t: 'bye' }]);
    expect(of('2'.repeat(16)).closed).toEqual(['background']);
  });

  it('dials a computer added later at once, redials one that moved, and drops one that went, without pairing again', () => {
    const { l, made, of } = links();
    l.open();
    l.setList([computer('1')]);
    expect(of('1'.repeat(16)).opens).toHaveLength(1);
    of('1'.repeat(16)).answer();
    l.setList([computer('1'), computer('2')]);
    expect(of('2'.repeat(16)).opens).toHaveLength(1);
    // The first one isn't dialed again for the list coming again.
    expect(made.filter((t) => t.computer.id === '1'.repeat(16))).toHaveLength(1);
    const before = of('1'.repeat(16));
    l.setList([computer('1', { address: '9'.repeat(64) }), computer('2')]);
    expect(before.disposed).toBe(true);
    expect(of('1'.repeat(16)).computer.address).toBe('9'.repeat(64));
    expect(of('1'.repeat(16)).opens).toHaveLength(1);
    l.setList([computer('1', { address: '9'.repeat(64) })]);
    expect(of('2'.repeat(16)).disposed).toBe(true);
    expect(l.states().map((s) => s.computer.id)).toEqual(['1'.repeat(16)]);
  });

  it('never links the computer its own pairing dials twice', () => {
    const { l } = links({ primary: '1'.repeat(64) });
    l.setList([computer('1'), computer('2')]);
    expect(l.states().map((s) => s.computer.id)).toEqual(['2'.repeat(16)]);
  });

  it('dials again by itself while you look, backing off, and never after it was turned away', () => {
    vi.useFakeTimers();
    const { l, of } = links();
    l.setList([computer('1'), computer('2')]);
    l.open();
    of('1'.repeat(16)).phases.emit('unreachable', 'Your Mac isn’t answering');
    expect(l.get('1'.repeat(16))?.phase).toBe('asleep');
    vi.advanceTimersByTime(1_000);
    expect(of('1'.repeat(16)).opens).toHaveLength(2);
    of('2'.repeat(16)).phases.emit('refused', 'This device was forgotten');
    vi.advanceTimersByTime(60_000);
    expect(of('2'.repeat(16)).opens).toHaveLength(1);
    expect(l.get('2'.repeat(16))).toMatchObject({ phase: 'refused', detail: 'This device was forgotten' });
  });

  it('keeps the list and when each was last reached, so it starts from them with your Mac asleep', () => {
    let now = 1_000;
    const first = links({ now: () => now });
    first.l.setList([computer('1', { lastSeen: 500 }), computer('2', { lastSeen: 700 })]);
    first.l.open();
    first.of('1'.repeat(16)).answer();
    now = 2_000;
    first.of('1'.repeat(16)).phases.emit('closed');
    expect(first.kept()?.list.map((c) => c.id)).toEqual(['1'.repeat(16), '2'.repeat(16)]);

    const again = links({ kept: first.kept() });
    expect(again.l.states().map((s) => ({ id: s.computer.id, phase: s.phase, lastSeen: s.lastSeen }))).toEqual([
      { id: '1'.repeat(16), phase: 'idle', lastSeen: 2_000 },
      { id: '2'.repeat(16), phase: 'idle', lastSeen: 700 },
    ]);
    again.l.open();
    expect(again.made.map((t) => t.opens.length)).toEqual([1, 1]);
  });

  it('passes each computer’s frames on, but not its own list of computers', () => {
    const { l, of, frames } = links();
    l.setList([computer('1')]);
    l.open();
    of('1'.repeat(16)).answer();
    of('1'.repeat(16)).frames.emit({ t: 'computers', list: [] });
    of('1'.repeat(16)).frames.emit({ t: 'nudge', kind: 'needsYou', title: 'Run npm test?', body: 'npm test' });
    expect(frames.map((f) => f.frame.t)).toEqual(['welcome', 'nudge']);
    expect(l.states()).toHaveLength(1);
    expect(l.send('1'.repeat(16), { t: 'sub', topics: ['work'] })).toBe(true);
    expect(l.send('2'.repeat(16), { t: 'sub', topics: ['work'] })).toBe(false);
  });
});
