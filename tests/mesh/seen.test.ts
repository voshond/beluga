import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DmBook } from '../../src/net/mesh/dms.js';
import { parseLink } from '../../src/net/mesh/wire.js';
import { dmConversation } from '../../src/net/mesh/views.js';
import { type Crowd, befriend, crowd, settle } from './helpers.js';

// Delivered, then Seen (BLG-798).

describe('DmBook Seen', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('their Seen covers your messages up to that one, once, and reads back after a restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dms-seen-'));
    dirs.push(dir);
    const b = new DmBook(dir);
    const one = b.compose('me', 'pal', 'one');
    const two = b.compose('me', 'pal', 'two');
    b.receive({ id: 'theirs-000001', from: 'pal', to: 'me', text: 'hi', ts: 3 });
    const three = b.compose('me', 'pal', 'three');
    expect(b.seenBy('pal', two.id).map((m) => m.id)).toEqual([one.id, two.id]);
    // Said again: nothing new. Their own message isn't for them to say Seen about.
    expect(b.seenBy('pal', two.id)).toEqual([]);
    expect(b.seenBy('pal', 'theirs-000001')).toEqual([]);
    expect(b.seenBy('pal', 'nothing-like-it')).toEqual([]);
    const again = new DmBook(dir);
    const status = again.status('pal');
    expect([...status.seen].sort()).toEqual([one.id, two.id].sort());
    expect(status.seen.has(three.id)).toBe(false);
  });

  it('older Beluga: a dm_seen frame is a kind of its own, and nothing else changes shape', () => {
    expect(parseLink(JSON.stringify({ t: 'dm_seen', id: 'abcdefgh1234' }))).toEqual({ t: 'dm_seen', id: 'abcdefgh1234' });
    expect(parseLink(JSON.stringify({ t: 'dm_seen', id: '../x' }))).toBeUndefined();
  });
});

describe('Seen between two Macs', () => {
  let net: Crowd;
  beforeAll(async () => {
    net = await crowd();
  }, 30_000);
  afterAll(async () => {
    await net.close();
  });

  it('shows Delivered when it arrives, and Seen only once it was on their screen', async () => {
    const ann = await net.add('ann');
    const bob = await net.add('bob');
    await befriend(ann, bob);
    const m = ann.mesh.sendDm(bob.identity.peerId, 'lunch?');
    const statusOf = (): string | undefined => ann.mesh.dmHistory(bob.identity.peerId).find((x) => x.id === m.id)?.status;
    await settle(() => statusOf() === 'delivered');
    // Bob's Beluga has it; nobody looked yet: still Delivered after a while.
    await new Promise((r) => setTimeout(r, 500));
    expect(statusOf()).toBe('delivered');
    bob.mesh.markSeen(dmConversation(ann.identity.peerId));
    await settle(() => statusOf() === 'seen');
    expect(ann.seen.some((v) => v.id === m.id && v.status === 'seen')).toBe(true);
  }, 60_000);
});
