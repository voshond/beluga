import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeshLink } from '../../src/net/mesh/link.js';
import { DEFAULT_TIMING, LinkManager, RETIRE_MS } from '../../src/net/mesh/links.js';
import type { LinkMessage } from '../../src/net/mesh/wire.js';
import type { MessageSocket } from '../../src/net/transport.js';

/**
 * Two Macs dialing each other at once each keep one of the two connections (BLG-728). What one side
 * sends on the other connection before it sees which is kept still arrives, and two sides that keep
 * different ones end up on the same one instead of dropping both.
 */

/** One end of an in-memory connection; closing either end closes both. */
class End extends EventEmitter implements MessageSocket {
  other!: End;
  private open = true;
  get isOpen(): boolean {
    return this.open;
  }
  send(data: string): void {
    if (this.open && this.other.open) this.other.emit('message', data);
  }
  close(code = 1000): void {
    this.end(code);
    this.other.end(code);
  }
  terminate(): void {
    this.close(1006);
  }
  ping(): void {}
  private end(code: number): void {
    if (!this.open) return;
    this.open = false;
    this.emit('close', code);
  }
}

const pair = (): [End, End] => {
  const a = new End();
  const b = new End();
  a.other = b;
  b.other = a;
  return [a, b];
};

interface Mac {
  readonly peerId: string;
  readonly links: LinkManager;
  readonly heard: string[];
  readonly unlinked: string[];
  adopt(socket: MessageSocket, from: string, outgoing: boolean): void;
  send(to: string, text: string): boolean;
}

// The lower address wins a simultaneous dial: X's.
const ADDRESS: Record<string, string> = { x: 'aa'.repeat(32), y: 'bb'.repeat(32) };

function mac(peerId: 'x' | 'y'): Mac {
  const other = peerId === 'x' ? 'y' : 'x';
  const heard: string[] = [];
  const unlinked: string[] = [];
  const links = new LinkManager({
    node: {} as never,
    NoiseStream: {} as never,
    keyPair: { publicKey: Buffer.from(ADDRESS[peerId]!, 'hex'), secretKey: Buffer.alloc(64) } as never,
    contacts: { byAddress: () => other, addressOf: (p) => ADDRESS[p], wanted: () => [], allows: (p) => p === other },
    timing: DEFAULT_TIMING,
    maxBytes: 1 << 20,
    relay: false,
    onLink: () => undefined,
    onUnlink: (p) => unlinked.push(p),
    onMessage: (_link: MeshLink, msg: LinkMessage) => {
      if (msg.t === 'call') heard.push(String(msg.p));
    },
  });
  const inner = links as unknown as { adopt(socket: MessageSocket, peerId: string, outgoing: boolean, via: 'direct'): boolean };
  return {
    peerId,
    links,
    heard,
    unlinked,
    adopt: (socket, from, outgoing) => void inner.adopt(socket, from, outgoing, 'direct'),
    send: (to, text) => {
      const link = links.get(to);
      link?.send({ t: 'call', p: text });
      return Boolean(link);
    },
  };
}

describe('two links to one friend (BLG-728)', () => {
  const macs: Mac[] = [];
  const both = (): [Mac, Mac] => {
    const pairOf = [mac('x'), mac('y')] as [Mac, Mac];
    macs.push(...pairOf);
    return pairOf;
  };
  afterEach(async () => {
    vi.useRealTimers();
    for (const m of macs.splice(0)) await m.links.close();
  });

  it('a message sent on the link the other side just gave up still arrives', () => {
    vi.useFakeTimers();
    const [x, y] = both();
    const [yDialed, yDialedAtX] = pair();
    const [xDialed, xDialedAtY] = pair();
    // Y has its own link, then X's comes in and wins (X's address is lower): Y gives up its own.
    y.adopt(yDialed, 'x', true);
    x.adopt(yDialedAtX, 'y', false);
    y.adopt(xDialedAtY, 'x', false);
    // X hasn't seen its own dial land yet, so it still sends on Y's.
    expect(x.send('y', 'ring')).toBe(true);
    expect(y.heard).toEqual(['ring']);

    x.adopt(xDialed, 'y', true);
    expect(x.send('y', 'again')).toBe(true);
    expect(y.heard).toEqual(['ring', 'again']);

    // The given-up link closes after a moment; the kept one stays and nobody went offline.
    vi.advanceTimersByTime(RETIRE_MS + 1);
    expect(yDialed.isOpen).toBe(false);
    expect(xDialed.isOpen).toBe(true);
    expect(y.send('x', 'answer')).toBe(true);
    expect(x.heard).toEqual(['answer']);
    expect([...x.unlinked, ...y.unlinked]).toEqual([]);
  });

  it('two sides that kept different links go on with the same one', () => {
    vi.useFakeTimers();
    const [x, y] = both();
    const [xDialed, xDialedAtY] = pair();
    const [yDialed, yDialedAtX] = pair();
    // X's dial lands on both sides, Y's a few seconds later. By its clock X counts that as Y coming
    // back (the newer one wins), Y as a simultaneous dial (X's, the lower address, wins).
    x.adopt(xDialed, 'y', true);
    vi.advanceTimersByTime(1_000);
    y.adopt(xDialedAtY, 'x', false);
    vi.advanceTimersByTime(2_500);
    y.adopt(yDialed, 'x', true);
    vi.advanceTimersByTime(100);
    x.adopt(yDialedAtX, 'y', false);

    // Y closes the one it gave up first: X goes back to the one Y kept, without going offline.
    vi.advanceTimersByTime(RETIRE_MS);
    expect(yDialed.isOpen).toBe(false);
    expect(xDialed.isOpen).toBe(true);
    expect(x.send('y', 'still here')).toBe(true);
    expect(y.heard).toEqual(['still here']);
    vi.advanceTimersByTime(RETIRE_MS * 2);
    expect(xDialed.isOpen).toBe(true);
    expect([...x.unlinked, ...y.unlinked]).toEqual([]);
  });
});
