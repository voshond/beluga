import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDrop, receivePiece, sendPiece } from '../src/machines/uploads.js';
import { UPLOAD_PIECE } from '../src/shared/uploads.js';
import { type Sending, envAsk, planDrop, sendFiles, sentShare } from '../packages/mac/src/chat/attachments.js';

/**
 * Images and files you add go to that computer (BLG-793): a file dropped on this Mac goes to the
 * computer a chat runs on a piece at a time over the link, written there as the phone's uploads
 * are, with its progress, and waits by its path there.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-up-'));
  dirs.push(d);
  return d;
};

/** The computer's side, as the door's own call reaches it. */
const computer = (session: object) => (method: string, args: readonly unknown[]) => {
  expect(method).toBe('machines.upload.put');
  return receivePiece(session, args[0] as number, args[1] as never);
};

describe('a file sent to a computer', () => {
  it('goes in pieces and arrives whole in its uploads', async () => {
    const here = tmp();
    const file = path.join(here, 'report.csv');
    const bytes = Buffer.alloc(UPLOAD_PIECE * 2 + 1234, 7);
    writeFileSync(file, bytes);
    const call = computer({});
    let off = 0;
    const seen: number[] = [];
    for (;;) {
      const r = await sendPiece(call, 1, file, off);
      seen.push(r.sent);
      if (r.path) {
        expect(r).toMatchObject({ total: bytes.length, name: 'report.csv', image: false });
        expect(r.path.startsWith(path.join(process.env.BELUGA_HOME!, 'uploads'))).toBe(true);
        expect(readFileSync(r.path).equals(bytes)).toBe(true);
        break;
      }
      off = r.sent;
    }
    expect(seen).toEqual([UPLOAD_PIECE, UPLOAD_PIECE * 2, bytes.length]);
  });

  it('says a picture is one, and an empty file arrives too', async () => {
    const here = tmp();
    writeFileSync(path.join(here, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(path.join(here, 'empty.txt'), '');
    const call = computer({});
    expect(await sendPiece(call, 2, path.join(here, 'shot.png'), 0)).toMatchObject({ image: true, sent: 4 });
    expect(await sendPiece(call, 3, path.join(here, 'empty.txt'), 0)).toMatchObject({ sent: 0, total: 0, path: expect.any(String) });
  });

  it('refuses a folder, a relative path, and a piece out of order', async () => {
    const here = tmp();
    mkdirSync(path.join(here, 'dir'));
    const call = computer({});
    await expect(sendPiece(call, 4, path.join(here, 'dir'), 0)).rejects.toThrow(/not folders/);
    await expect(sendPiece(call, 5, 'notes.txt', 0)).rejects.toThrow(/on this Mac/);
    const file = path.join(here, 'a.bin');
    writeFileSync(file, Buffer.alloc(UPLOAD_PIECE + 10));
    await expect(sendPiece(call, 6, file, 10)).rejects.toThrow(/start at 0/);
  });
});

describe('sendFiles', () => {
  it('sends one file after another with their progress, going on past one that fails', async () => {
    const here = tmp();
    const big = path.join(here, 'big.mov');
    const pic = path.join(here, 'cat.png');
    writeFileSync(big, Buffer.alloc(UPLOAD_PIECE + 5, 1));
    writeFileSync(pic, Buffer.from([1, 2, 3]));
    const call = computer({});
    const progress: Array<Sending | undefined> = [];
    const failed: string[] = [];
    const arrived = await sendFiles(
      (_m, n, file, off) => (file.endsWith('gone.txt') ? Promise.reject(new Error('ENOENT')) : sendPiece(call, n, file, off)),
      'de30a1c0ffee0002',
      [
        { path: big, name: 'big.mov', kind: 'file', size: UPLOAD_PIECE + 5, image: false },
        { path: path.join(here, 'gone.txt'), name: 'gone.txt', kind: 'file', size: 3, image: false },
        { path: pic, name: 'cat.png', kind: 'file', size: 3, image: true },
      ],
      (s) => progress.push(s),
      (f) => failed.push(f.name),
    );
    expect(arrived.map((f) => [f.name, f.image])).toEqual([
      ['big.mov', false],
      ['cat.png', true],
    ]);
    expect(arrived.every((f) => f.path.includes(path.join(process.env.BELUGA_HOME!, 'uploads')))).toBe(true);
    expect(failed).toEqual(['gone.txt']);
    expect(progress.filter((s) => s?.name === 'big.mov').map((s) => sentShare(s!))).toEqual(['0%', '99%', '100%']);
    expect(progress.at(-1)).toBeUndefined();
  });
});

/**
 * Dropping a .env on a remote chat asks like a send (BLG-854): the env send's rules decide before a
 * byte goes. An env file asks first, by its name, never its value; a key, a certificate or a file
 * in a credential folder or Beluga's own is refused with why (links followed); anything else goes.
 */
describe('a file dropped on a chat on a computer', () => {
  const SECRET = 'STRIPE_KEY=sk_live_never_shown';

  function files() {
    const here = tmp();
    const write = (rel: string, text: string): string => {
      const p = path.join(here, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
      return p;
    };
    const pem = write('server.pem', 'KEY');
    const link = path.join(here, 'looks-plain.txt');
    symlinkSync(pem, link);
    return {
      env: write('.env', SECRET),
      envLocal: write('.env.local', SECRET),
      plain: write('notes.txt', 'hello'),
      pem,
      inCredentials: write(path.join('.aws', 'config'), 'KEY'),
      link,
    };
  }

  it('asks for an env file, refuses keys and credential folders with why, and lets the rest go', async () => {
    const f = files();
    expect(await checkDrop(f.env)).toMatchObject({ name: '.env', verdict: 'ask' });
    expect(await checkDrop(f.envLocal)).toMatchObject({ verdict: 'ask' });
    expect(await checkDrop(f.plain)).toMatchObject({ verdict: 'send' });
    expect(await checkDrop(f.pem)).toMatchObject({ verdict: 'refuse', reason: 'keys and certificates stay on this Mac' });
    expect(await checkDrop(f.inCredentials)).toMatchObject({ verdict: 'refuse', reason: 'keys and credentials stay on this Mac' });
    // A plain name that links to a key is the key.
    expect(await checkDrop(f.link)).toMatchObject({ verdict: 'refuse' });
  });

  it('refuses Beluga’s own folder', async () => {
    const own = path.join(process.env.BELUGA_HOME!, 'device-key.json');
    writeFileSync(own, '{}');
    expect(await checkDrop(own)).toMatchObject({ verdict: 'refuse', reason: 'Beluga’s own files stay on this Mac' });
  });

  it('sends an env file only after Send Once, never a refused one, and the rest as before', async () => {
    const f = files();
    const call = computer({});
    await expect(sendPiece(call, 20, f.env, 0)).rejects.toThrow(/\.env holds secrets: say Send Once first/);
    expect(await sendPiece(call, 21, f.env, 0, { env: true })).toMatchObject({ path: expect.any(String), sent: SECRET.length });
    await expect(sendPiece(call, 22, f.pem, 0, { env: true })).rejects.toThrow(/server\.pem stays on this Mac/);
    expect(await sendPiece(call, 23, f.plain, 0)).toMatchObject({ path: expect.any(String) });
  });

  it('splits a drop, and the ask names the files, never their values', async () => {
    const f = files();
    const info = (p: string) => ({ path: p, name: path.basename(p), kind: 'file' as const, size: 1, image: false });
    const picked = [f.env, f.plain, f.pem].map(info);
    const plan = planDrop(picked, await Promise.all(picked.map((p) => checkDrop(p.path))));
    expect(plan.send.map((x) => x.name)).toEqual(['notes.txt']);
    expect(plan.ask.map((x) => x.name)).toEqual(['.env']);
    expect(plan.refused).toEqual([{ name: 'server.pem', reason: 'keys and certificates stay on this Mac' }]);
    const ask = envAsk(plan.ask, 'build-box', () => undefined);
    expect(ask).toMatchObject({ title: 'Send .env to build-box?', confirm: 'Send Once', cancel: 'Don’t Send' });
    expect(JSON.stringify(ask)).not.toContain('sk_live');
  });
});
