import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatFiles } from '../../src/core/chat/files.js';
import { cleanFileName, parseExtras } from '../../src/net/mesh/extras.js';
import type { ChatFileState } from '../../src/net/mesh/views.js';
import { dmConversation, groupConversation } from '../../src/net/mesh/views.js';
import { type Crowd, type Person, befriend, crowd, settle } from '../mesh/helpers.js';

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

const id = (p: Person): string => p.identity.peerId;
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'klaud-chat-files-'));

/** A person with chat files on, and the file states their screen would see. */
function withFiles(p: Person, autoBytes?: number): { files: ChatFiles; states: Record<string, ChatFileState> } {
  const states: Record<string, ChatFileState> = {};
  const files = new ChatFiles({
    mesh: p.mesh,
    dir: path.join(p.dir, 'chat-files'),
    onState: (patch) => {
      for (const [sha, s] of Object.entries(patch)) {
        if (s) states[sha] = s;
        else delete states[sha];
      }
    },
    ...(autoBytes !== undefined ? { autoBytes } : {}),
  });
  return { files, states };
}

describe('message extras', () => {
  it('keeps files, asks and Claude answers; drops anything malformed', () => {
    const sha = 'a'.repeat(64);
    expect(parseExtras({ files: [{ sha, name: '../../etc/passwd', size: 3 }], ask: { to: 'all' } })).toEqual({ files: [{ sha, name: 'passwd', size: 3 }], ask: { to: 'all' } });
    expect(parseExtras({ files: [{ sha: 'nope', name: 'x', size: 1 }] })).toBeUndefined();
    expect(parseExtras({ text: 'only text' })).toBeUndefined();
    expect(parseExtras({ claude: { for: 'm1' } })).toEqual({ claude: { for: 'm1' } });
    expect(cleanFileName('..hidden‮txt.exe')).toBe('hiddentxt.exe');
    expect(cleanFileName('')).toBe('file');
  });
});

describe('files in chats', () => {
  it('a file sent in a direct message arrives whole, checked, straight from Mac to Mac', async () => {
    const [ann, bob] = await Promise.all([net.add('ann'), net.add('bob')]);
    await befriend(ann, bob);
    const a = withFiles(ann);
    const b = withFiles(bob);
    const src = path.join(tmp(), 'notes.bin');
    const bytes = randomBytes(3 * 1024 * 1024 + 123);
    writeFileSync(src, bytes);

    const [file] = await a.files.share([src]);
    expect(file).toMatchObject({ name: 'notes.bin', size: bytes.length });
    // Pasted media of any size comes in parts.
    expect(await a.files.sharePart('clip.mov', Buffer.from('part1-'), { id: 'upload-1x', last: false })).toBeUndefined();
    expect(await a.files.sharePart('clip.mov', Buffer.from('part2'), { id: 'upload-1x', last: true })).toMatchObject({ name: 'clip.mov', size: 11, mime: 'video/quicktime' });
    // Pasted bytes keep the name they were given.
    expect(await a.files.shareData('Pasted image.png', Buffer.from('png!'))).toMatchObject({ name: 'Pasted image.png', size: 4, mime: 'image/png', image: true });
    ann.mesh.sendDm(id(bob), 'here you go', { files: [file!] });

    // Small enough to come by itself.
    const got = await settle(() => b.states[file!.sha]?.state === 'here' && b.states[file!.sha]);
    // Byte for byte, natively: toEqual walks a 3 MB Buffer index by index (about 20 s, and past the
    // test's timeout on a busy machine).
    expect(readFileSync(got.path!).equals(bytes)).toBe(true);
    expect(path.basename(got.path!)).toBe('notes.bin');
    expect(bob.mesh.dmHistory(id(ann)).at(-1)).toMatchObject({ text: 'here you go', files: [{ sha: file!.sha, name: 'notes.bin' }] });
    a.files.stop();
    b.files.stop();
  });

  it('big files wait for Download; someone outside the conversation can’t get them', async () => {
    const [ann, bob, cat] = await Promise.all([net.add('ann2'), net.add('bob2'), net.add('cat2')]);
    await befriend(ann, bob);
    await befriend(ann, cat);
    const a = withFiles(ann);
    const b = withFiles(bob, 1024);
    const c = withFiles(cat);
    const src = path.join(tmp(), 'big.dat');
    writeFileSync(src, randomBytes(800 * 1024));
    const [file] = await a.files.share([src]);
    ann.mesh.sendDm(id(bob), '', { files: [file!] });
    await settle(() => bob.mesh.dmHistory(id(ann)).some((m) => m.files?.length));
    // Older Macs read "📎 big.dat"; this one shows just the file.
    expect(bob.mesh.dmHistory(id(ann)).at(-1)?.text).toBe('');
    await new Promise((r) => setTimeout(r, 300));
    expect(b.states[file!.sha]).toBeUndefined();
    b.files.download(file!.sha, dmConversation(id(ann)));
    await settle(() => b.states[file!.sha]?.state === 'here');

    // cat never saw it: she can't even ask for it.
    expect(() => c.files.download(file!.sha)).toThrow(/wasn’t shared/);
    a.files.stop();
    b.files.stop();
    c.files.stop();
  });

  it('in a group, a file comes from another member when the one who shared it is gone', async () => {
    const [ann, bob, cat] = await Promise.all([net.add('ann3'), net.add('bob3'), net.add('cat3')]);
    await befriend(ann, bob);
    await befriend(ann, cat);
    const g = ann.mesh.createGroup('crew', [id(bob), id(cat)]);
    await settle(() => bob.group(g.id)?.active && cat.group(g.id)?.active);
    await settle(() => [ann, bob, cat].every((p) => p.group(g.id)?.members.every((m) => m.online)));
    const a = withFiles(ann);
    const b = withFiles(bob);
    const c = withFiles(cat, 0);
    const src = path.join(tmp(), 'deck.pdf');
    const bytes = randomBytes(600 * 1024);
    writeFileSync(src, bytes);
    const [file] = await a.files.share([src]);
    expect(file).toMatchObject({ mime: 'application/pdf' });
    ann.mesh.sendGroup(g.id, 'the deck', { files: [file!] });
    await settle(() => b.states[file!.sha]?.state === 'here');
    await settle(() => cat.mesh.groupHistory(g.id).some((m) => m.files?.length));

    // ann quits; cat still gets it, from bob.
    a.files.stop();
    await ann.stop();
    await settle(() => !cat.mesh.isLinked(id(ann)));
    c.files.download(file!.sha, groupConversation(g.id));
    const got = await settle(() => c.states[file!.sha]?.state === 'here' && c.states[file!.sha]);
    expect(readFileSync(got.path!).equals(bytes)).toBe(true);
    b.files.stop();
    c.files.stop();
  });

  it('a file nobody online has waits, then comes when they’re back', async () => {
    const [ann, bob] = await Promise.all([net.add('ann4'), net.add('bob4')]);
    await befriend(ann, bob);
    let a = withFiles(ann);
    const b = withFiles(bob, 0);
    const src = path.join(tmp(), 'later.txt');
    writeFileSync(src, 'see you later');
    const [file] = await a.files.share([src]);
    ann.mesh.sendDm(id(bob), 'for later', { files: [file!] });
    await settle(() => bob.mesh.dmHistory(id(ann)).some((m) => m.files?.length));
    a.files.stop();
    await ann.stop();
    await settle(() => !bob.mesh.isLinked(id(ann)));
    b.files.download(file!.sha);
    await settle(() => b.states[file!.sha]?.error?.includes('Waiting'));
    await ann.start();
    a = withFiles(ann);
    const got = await settle(() => b.states[file!.sha]?.state === 'here' && b.states[file!.sha]);
    expect(readFileSync(got.path!, 'utf8')).toBe('see you later');
    expect(existsSync(path.join(path.dirname(got.path!), '.part'))).toBe(false);
    a.files.stop();
    b.files.stop();
  });

  it('knowing a checksum isn’t enough: posting it yourself doesn’t get you someone else’s file', async () => {
    const [ann, bob, cat] = await Promise.all([net.add('ann5'), net.add('bob5'), net.add('cat5')]);
    await befriend(ann, bob);
    await befriend(ann, cat);
    const a = withFiles(ann);
    const b = withFiles(bob);
    const c = withFiles(cat, 0);
    const src = path.join(tmp(), 'private.txt');
    writeFileSync(src, 'only for bob');
    const [file] = await a.files.share([src]);
    ann.mesh.sendDm(id(bob), 'just for you', { files: [file!] });
    await settle(() => b.states[file!.sha]?.state === 'here');
    // cat learned the checksum somehow and claims it in a channel with both of them.
    const g = ann.mesh.createGroup('all', [id(bob), id(cat)]);
    await settle(() => [bob, cat].every((p) => p.group(g.id)?.active));
    await settle(() => [ann, bob, cat].every((p) => p.group(g.id)?.members.every((m) => m.online)));
    cat.mesh.sendGroup(g.id, 'mine', { files: [file!] });
    await settle(() => bob.mesh.groupHistory(g.id).some((m) => m.files?.length));
    c.files.download(file!.sha, groupConversation(g.id));
    await settle(() => c.states[file!.sha]?.error?.includes('Waiting'));
    expect(c.states[file!.sha]?.state).not.toBe('here');
    a.files.stop();
    b.files.stop();
    c.files.stop();
  });
});
