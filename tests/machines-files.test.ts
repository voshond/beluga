import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShareService } from '../src/core/shares.js';
import { encodeFrame, parseDaemonFrame } from '../src/ipc/protocol.js';
import { MachineDoor } from '../src/machines/door.js';
import { FRESH_MS, FileCache, rangeAsk } from '../src/machines/files.js';
import type { Machines } from '../src/machines/machines.js';
import { FIRST_RANGE, type TextRange, textEnd } from '../src/shared/text-range.js';
import { waitFor } from './helpers.js';

/**
 * A computer's files, streamed and instant (BLG-791): a file read in pieces that never split a
 * line or a character, the same files refused as a whole read refuses, and this Mac's cache of what
 * a computer sent: capped in memory and on disk, never a secret, cleared when the computer is
 * forgotten, and answering the file under the pointer at once with 80 ms added round trip.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-files-'));
  dirs.push(d);
  return d;
};

describe('textEnd', () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('ends after the last line end in the second half', () => {
    const b = bytes('one\ntwo\nthree');
    expect(textEnd(b, false)).toBe('one\ntwo\n'.length);
  });

  it('never splits a character when no line ends nearby', () => {
    const b = bytes('aaaaaaaaaé✓🐳');
    for (let cut = 1; cut <= b.length; cut += 1) {
      const end = textEnd(b.subarray(0, cut), false);
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, end))).not.toThrow();
      expect(end).toBeGreaterThan(0);
    }
  });

  it('takes everything at the end of the file', () => {
    expect(textEnd(bytes('no line end'), true)).toBe(11);
  });
});

describe('ShareService.readRange', () => {
  function project(): { shares: ShareService; root: string } {
    const root = tmp();
    return { shares: new ShareService([{ name: 'ws', root, writable: true, private: true }]), root };
  }

  it('opens a 5 MB file by its first piece and streams the rest exactly', async () => {
    const { shares, root } = project();
    const line = (i: number): string => `${String(i).padStart(7, '0')} the quick brown fox — jumps over the lazy dog ✓\n`;
    let text = '';
    for (let i = 0; text.length < 5 * 1024 * 1024; i += 1) text += line(i);
    writeFileSync(path.join(root, 'big.log'), text);

    const started = performance.now();
    const first = await shares.readRange('ws', 'big.log', 0, FIRST_RANGE, true);
    expect(performance.now() - started).toBeLessThan(150);
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(FIRST_RANGE);
    expect(first.content.endsWith('\n')).toBe(true);
    expect(first.total).toBe(Buffer.byteLength(text));
    expect(first.next).toBe(Buffer.byteLength(first.content));

    let all = first.content;
    let next = first.next;
    while (next !== undefined) {
      const piece: TextRange = await shares.readRange('ws', 'big.log', next, 256 * 1024, true);
      expect(piece.offset).toBe(next);
      all += piece.content;
      next = piece.next;
    }
    expect(all).toBe(text);
  });

  it('says a binary file is binary', async () => {
    const { shares, root } = project();
    writeFileSync(path.join(root, 'a.bin'), Buffer.from([1, 2, 0, 3]));
    expect(await shares.readRange('ws', 'a.bin', 0, 1024, true)).toMatchObject({ binary: true, content: '[binary file]' });
  });

  it('refuses what a whole read refuses: keys, credential stores, git internals, a way out', async () => {
    const { shares, root } = project();
    mkdirSync(path.join(root, '.ssh'));
    writeFileSync(path.join(root, '.ssh', 'id_ed25519'), 'secret');
    writeFileSync(path.join(root, 'server.pem'), 'secret');
    writeFileSync(path.join(root, '.env'), 'TOKEN=secret');
    for (const p of ['.ssh/id_ed25519', 'server.pem', '../outside.txt']) await expect(shares.readRange('ws', p, 0, 100, true)).rejects.toThrow();
    // A guest never reads the project's .env; you (its owner) do, as in your Files tab.
    await expect(shares.readRange('ws', '.env', 0, 100, false)).rejects.toThrow(/private/);
  });
});

describe('FileCache', () => {
  const piece = (content: string, at = 0): TextRange => ({ content, offset: at, total: content.length, mtime: 1 });
  const ask = (p: string, offset = 0) => rangeAsk([{ owner: 'o', share: 'ws', path: p }, { offset, length: 1024 }])!;

  it('keeps memory under its cap, the least used going first', async () => {
    const cache = new FileCache({ memoryBytes: 3 * (200 + 128) });
    for (const name of ['a', 'b', 'c']) cache.put('m1', ask(name), piece('x'.repeat(100)));
    await cache.get('m1', ask('a').key); // a is used again: b is now the oldest
    cache.put('m1', ask('d'), piece('x'.repeat(100)));
    expect(cache.size.memory).toBeLessThanOrEqual(3 * (200 + 128));
    expect(await cache.get('m1', ask('b').key)).toBeUndefined();
    expect((await cache.get('m1', ask('a').key))?.value.content).toHaveLength(100);
  });

  it('keeps its folder under its cap and reads it back after a restart', async () => {
    const dir = path.join(tmp(), 'cache');
    let clock = 1_000;
    const cache = new FileCache({ dir, memoryBytes: 1, diskBytes: 4_000, now: () => clock++ });
    for (let i = 0; i < 20; i += 1) cache.put('m1', ask(`f${i}.ts`), piece('y'.repeat(500)));
    await cache.flush();
    expect(cache.size.disk).toBeLessThanOrEqual(4_000);
    const again = new FileCache({ dir, diskBytes: 4_000 });
    expect(await again.get('m1', ask('f0.ts').key)).toBeUndefined();
    expect((await again.get('m1', ask('f19.ts').key))?.value.content).toBe('y'.repeat(500));
  });

  it('never keeps a secret', async () => {
    const dir = path.join(tmp(), 'cache');
    const cache = new FileCache({ dir });
    for (const p of ['.env', '.env.local', 'deploy/server.key', '.ssh/id_rsa']) cache.put('m1', ask(p), piece('TOKEN=1'));
    await cache.flush();
    expect(cache.size).toEqual({ memory: 0, disk: 0 });
    expect(readdirSync(path.dirname(dir))).toEqual([]);
  });

  it('clears one computer’s files, and only its', async () => {
    const dir = path.join(tmp(), 'cache');
    const cache = new FileCache({ dir });
    cache.put('m1', ask('a.ts'), piece('one'));
    cache.put('m2', ask('a.ts'), piece('two'));
    await cache.flush();
    expect(readdirSync(dir)).toHaveLength(2);
    await cache.clear('m1');
    expect(await cache.get('m1', ask('a.ts').key)).toBeUndefined();
    expect((await cache.get('m2', ask('a.ts').key))?.value.content).toBe('two');
    expect(readdirSync(dir)).toHaveLength(1);
    expect(await new FileCache({ dir }).get('m1', ask('a.ts').key)).toBeUndefined();
  });
});

/** A computer behind a link with `rtt` ms added round trip, answering files.readRange from `files`. */
class SlowLink extends EventEmitter {
  isOpen = true;
  readonly calls: string[] = [];
  constructor(
    private readonly rtt: number,
    private readonly files: Record<string, string>,
  ) {
    super();
  }
  send(text: string): void {
    const frame = JSON.parse(text) as { t: string; id?: string; method?: string; args?: unknown[] };
    const later = (reply: object): void => void setTimeout(() => this.isOpen && this.emit('message', encodeFrame(reply as never)), this.rtt);
    if (frame.t === 'hello') return later({ t: 'welcome', clientId: 'c', version: '1', ipc: 1, snapshot: {}, seq: 0, clients: 1 });
    if (frame.t !== 'call') return;
    this.calls.push(frame.method!);
    const at = frame.args![0] as { path: string };
    const content = this.files[at.path];
    later(content === undefined ? { t: 'result', id: frame.id, ok: false, error: 'ENOENT' } : { t: 'result', id: frame.id, ok: true, value: { content, offset: 0, total: content.length, mtime: 1 } });
  }
  close(): void {
    this.isOpen = false;
    this.emit('close', 1006);
  }
  terminate(): void {
    this.close();
  }
  ping(): void {}
}

class FakeScreen extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly got: Array<{ t: string; id?: string; ok?: boolean; value?: TextRange }> = [];
  send(text: string): void {
    this.got.push(parseDaemonFrame(text) as never);
  }
  close(): void {
    this.readyState = 3;
  }
  say(frame: object): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }
  async ask(id: string, path: string, cache?: boolean): Promise<{ ms: number; value?: TextRange; ok?: boolean }> {
    const started = performance.now();
    this.say({ t: 'call', id, method: 'files.readRange', args: [{ owner: 'mini', share: 'ws', path }, { offset: 0, length: FIRST_RANGE, ...(cache ? { cache } : {}) }] });
    await waitFor(() => this.got.some((f) => f.t === 'result' && f.id === id), 5_000);
    const r = this.got.find((f) => f.t === 'result' && f.id === id)!;
    return { ms: performance.now() - started, ...(r.value ? { value: r.value } : {}), ok: r.ok! };
  }
}

describe('the door’s cache, with 80 ms added round trip', () => {
  async function open(dir: string, link: SlowLink, now?: () => number) {
    const files = new FileCache({ dir, ...(now ? { now } : {}) });
    const machines = { book: { get: () => ({ name: 'Mini' }) }, drives: () => true, openLink: async () => link } as unknown as Machines;
    const door = new MachineDoor(machines, { files, backoffMs: [60_000], ...(now ? { now } : {}) });
    const screen = new FakeScreen();
    door.open('mini', screen as never, { t: 'hello', token: 't'.repeat(32), ipc: 1, kind: 'mac', version: '1', caps: [] });
    await waitFor(() => screen.got.some((f) => f.t === 'welcome'), 5_000);
    return { door, screen, files };
  }

  it('shows the file under the pointer well under 150 ms after the click', async () => {
    const home = tmp();
    const link = new SlowLink(80, { 'src/app.ts': 'export const app = 1;\n' });
    const { screen, files, door } = await open(path.join(home, 'cache', 'computer-files'), link);
    // Cold: the round trip.
    const cold = await screen.ask('1', 'src/app.ts', true);
    expect(cold.ms).toBeGreaterThanOrEqual(75);
    // Read ahead under the pointer, then the click: answered here.
    const click = await screen.ask('2', 'src/app.ts', true);
    expect(click.value?.content).toBe('export const app = 1;\n');
    expect(click.ms).toBeLessThan(150);
    expect(click.ms).toBeLessThan(40);
    expect(link.calls).toEqual(['files.readRange']);
    // A read that must be current (after a change) asks the computer again.
    await screen.ask('3', 'src/app.ts');
    expect(link.calls).toHaveLength(2);
    await files.flush();
    // Nothing is written on this Mac but the cache's own folder.
    expect(readdirSync(home)).toEqual(['cache']);
    expect(readdirSync(path.join(home, 'cache'))).toEqual(['computer-files']);
    door.closeAll('done');
  });

  it('asks again once a kept piece is older than a moment', async () => {
    let clock = 0;
    const link = new SlowLink(5, { 'a.ts': 'a\n' });
    const { screen, door } = await open(path.join(tmp(), 'c'), link, () => clock);
    await screen.ask('1', 'a.ts', true);
    clock += FRESH_MS + 1;
    await screen.ask('2', 'a.ts', true);
    expect(link.calls).toHaveLength(2);
    door.closeAll('done');
  });

  it('keeps an offline computer’s files readable, said stale', async () => {
    const link = new SlowLink(5, { 'a.ts': 'a\n' });
    const { screen, door } = await open(path.join(tmp(), 'c'), link);
    await screen.ask('1', 'a.ts');
    link.close();
    const offline = await screen.ask('2', 'a.ts');
    expect(offline).toMatchObject({ ok: true, value: { content: 'a\n', stale: true } });
    // Never read: said plainly, as any call while it's down.
    expect(await screen.ask('3', 'b.ts')).toMatchObject({ ok: false });
    door.closeAll('done');
  });
});
