import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvSend, type EnvSendAsk, type EnvFilePayload, envHere, readForSending, receiveEnv, refusedEnvPath, sameRepoKey, sendableEnvFiles, writeSentEnv } from '../src/machines/env-send.js';

/**
 * .env files for a worktree made on one of your computers (BLG-800): asked with names only, sent
 * when you say, Always remembered and taken back, refused paths refused whatever you choose, and
 * written 0600 there, never over a file that's there.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beluga-envsend-'));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const SECRET = 'sk_live_do_not_leak_42';

describe('what may be sent', () => {
  it('env files go; keys, .ssh, .aws, ~/.beluga-like folders, templates and paths out of the project never do', () => {
    expect(refusedEnvPath('.env')).toBeUndefined();
    expect(refusedEnvPath('apps/web/.env.local')).toBeUndefined();
    expect(refusedEnvPath('.dev.vars')).toBeUndefined();
    for (const bad of ['.ssh/id_ed25519', '.ssh/.env', '.aws/credentials', '.aws/.env', '.beluga/.env', 'x/.gnupg/.env', 'server.pem', 'tls/.env.key', 'id_rsa', '.env.example', 'README.md', '../.env', '/etc/.env', 'a//.env', './.env']) {
      expect(refusedEnvPath(bad), bad).toBeDefined();
    }
  });

  it('lists a checkout’s sendable env files: never its .ssh or .aws files', async () => {
    const root = tmp();
    put(root, '.env', `KEY=${SECRET}\n`);
    put(root, '.env.example', 'KEY=\n');
    put(root, '.ssh/id_ed25519', 'PRIVATE');
    put(root, '.aws/credentials', 'aws');
    expect(await sendableEnvFiles(root)).toEqual(['.env']);
  });

  it('reads only plain files inside the project: a .env linked to a key, or one too big, stays', async () => {
    const root = tmp();
    const outside = tmp();
    put(outside, 'id_rsa', 'PRIVATE KEY');
    put(root, '.env', `KEY=${SECRET}\n`);
    symlinkSync(path.join(outside, 'id_rsa'), path.join(root, '.env.local'));
    put(root, '.env.big', 'x'.repeat(300 * 1024));
    const sent = await readForSending(root, ['.env', '.env.local', '.env.big', '.ssh/id_rsa']);
    expect(sent.map((f) => f.path)).toEqual(['.env']);
    expect(Buffer.from(sent[0]!.data, 'base64').toString()).toBe(`KEY=${SECRET}\n`);
  });

  it('nothing under ~/.beluga is read, wherever the project is', async () => {
    const home = tmp();
    const root = path.join(home, 'project');
    put(root, '.env', 'A=1\n');
    expect(await readForSending(root, ['.env'], root)).toEqual([]);
    expect((await readForSending(root, ['.env'], path.join(home, 'elsewhere'))).map((f) => f.path)).toEqual(['.env']);
  });
});

describe('on the computer', () => {
  const file = (p: string, text: string): EnvFilePayload => ({ path: p, data: Buffer.from(text).toString('base64') });

  it('writes 0600 into the project folder and the worktree, never over a file there, never outside', async () => {
    const project = tmp();
    const worktree = tmp();
    const outside = tmp();
    put(worktree, '.env.local', 'MINE=1\n');
    symlinkSync(outside, path.join(project, 'linked'));
    symlinkSync(outside, path.join(worktree, 'linked'));
    const written = await writeSentEnv([project, worktree], [file('.env', `KEY=${SECRET}\n`), file('apps/web/.env.local', 'B=2\n'), file('.env.local', 'THEIRS=1\n'), file('../.env', 'X=1'), file('linked/.env', 'X=1'), file('.ssh/.env', 'X=1'), file('id_rsa', 'X')]);
    expect(written).toEqual(['.env', '.env.local', 'apps/web/.env.local']);
    for (const dir of [project, worktree]) {
      expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe(`KEY=${SECRET}\n`);
      if (process.platform !== 'win32') expect(statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);
      if (process.platform !== 'win32') expect(statSync(path.join(dir, 'apps/web/.env.local')).mode & 0o777).toBe(0o600);
    }
    // The worktree's own file stays as it was.
    expect(readFileSync(path.join(worktree, '.env.local'), 'utf8')).toBe('MINE=1\n');
    expect(() => statSync(path.join(outside, '.env'))).toThrow();
    expect(() => statSync(path.join(path.dirname(project), '.env'))).toThrow();
  });

  it('says a worktree’s project and the env file names it has, and receives into it', async () => {
    const root = tmp();
    const wt = tmp();
    put(root, '.env.test', 'T=1\n');
    const state = { projects: [{ name: 'shop', root, workspaces: [{ id: 'ws-1', path: wt }] }] };
    expect(await envHere(state, 'ws-1')).toEqual({ project: { name: 'shop' }, files: ['.env.test'] });
    expect(await envHere(state, 'nope')).toBeUndefined();
    expect(await receiveEnv(state, ['ws-1'], [file('.env', 'A=1\n')])).toEqual({ written: ['.env'] });
    if (process.platform !== 'win32') expect(statSync(path.join(wt, '.env')).mode & 0o777).toBe(0o600);
    await expect(receiveEnv(state, ['gone'], [file('.env', 'A=1\n')])).rejects.toThrow(/gone/);
  });
});

describe('the ask in your app', () => {
  function setup(theirs: string[] = []) {
    const root = tmp();
    put(root, '.env', `KEY=${SECRET}\n`);
    put(root, '.env.local', `OTHER=${SECRET}\n`);
    put(root, '.ssh/id_ed25519', 'PRIVATE');
    const published: (readonly EnvSendAsk[])[] = [];
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const logs: string[] = [];
    const deps = {
      file: path.join(tmp(), 'env-send.json'),
      projects: () => [{ id: 'p1', name: 'shop', root }],
      machineName: () => 'Mac mini',
      origin: async () => 'https://github.com/acme/shop.git',
      publish: (asks: readonly EnvSendAsk[]) => void published.push(asks),
      log: (line: string) => void logs.push(line),
      call: async (_m: string, method: string, args: readonly unknown[]) => {
        calls.push({ method, args });
        if (method === 'machines.env.here') return { project: { name: 'shop', remote: 'git@github.com:acme/shop' }, files: theirs };
        return { written: (args[1] as EnvFilePayload[]).map((f) => f.path) };
      },
    };
    return { root, published, calls, logs, deps, send: new EnvSend(deps) };
  }

  it('asks with the missing files’ names and never a value; Send Once sends them and asks again next time', async () => {
    const { send, published, calls, logs } = setup(['.env.local']);
    expect(await send.offer('m1', 'ws-1')).toBe('asked');
    const ask = published.at(-1)![0]!;
    expect(ask).toMatchObject({ machineName: 'Mac mini', projectName: 'shop', files: ['.env'], workspaceIds: ['ws-1'] });
    expect(JSON.stringify(published)).not.toContain(SECRET);
    expect(calls.map((c) => c.method)).toEqual(['machines.env.here']);

    expect(await send.decide(ask.id, 'once')).toEqual({ sent: ['.env'] });
    expect(published.at(-1)).toEqual([]);
    const sent = calls.at(-1)!;
    expect(sent.method).toBe('machines.env.receive');
    expect(sent.args[0]).toEqual(['ws-1']);
    expect(logs.join('\n')).not.toContain(SECRET);
    // Once is once.
    expect(await send.offer('m1', 'ws-2')).toBe('asked');
  });

  it('a second worktree of the same project on that computer joins the open ask', async () => {
    const { send, published } = setup();
    await send.offer('m1', 'ws-1');
    await send.offer('m1', 'ws-2');
    expect(published.at(-1)).toHaveLength(1);
    expect(published.at(-1)![0]!.workspaceIds).toEqual(['ws-1', 'ws-2']);
  });

  it('Always for This Project sends without asking next time, until Settings takes it back', async () => {
    const { send, published, calls, root } = setup();
    await send.offer('m1', 'ws-1');
    await send.decide(published.at(-1)![0]!.id, 'always');
    expect(send.always().map((a) => a.root)).toEqual([root]);
    const before = published.length;
    expect(await send.offer('m1', 'ws-2')).toBe('sent');
    expect(published.length).toBe(before);
    expect(calls.at(-1)!.method).toBe('machines.env.receive');
    // Refused paths stay refused with Always too: the key in .ssh was never offered or sent.
    const payload = calls.filter((c) => c.method === 'machines.env.receive').flatMap((c) => (c.args[1] as EnvFilePayload[]).map((f) => f.path));
    expect(payload.every((p) => !p.startsWith('.ssh'))).toBe(true);
    expect(send.forget(root)).toEqual([]);
    expect(await send.offer('m1', 'ws-3')).toBe('asked');
  });

  it('Don’t Send sends nothing; a project already complete there, or not one here, asks nothing', async () => {
    const { send, published, calls } = setup();
    await send.offer('m1', 'ws-1');
    expect(await send.decide(published.at(-1)![0]!.id, 'never')).toEqual({ sent: [] });
    expect(calls.some((c) => c.method === 'machines.env.receive')).toBe(false);
    await expect(send.decide('gone', 'once')).rejects.toThrow(/already answered/);

    expect(await setup(['.env', '.env.local']).send.offer('m1', 'ws-1')).toBe('none');
    const other = setup();
    const elsewhere = new EnvSend({ ...other.deps, origin: async () => 'https://github.com/someone/else' });
    expect(await elsewhere.offer('m1', 'ws-1')).toBe('none');
  });

  it('matches projects across computers by their origin, however it’s written', () => {
    expect(sameRepoKey('git@github.com:acme/shop.git')).toBe('github.com/acme/shop');
    expect(sameRepoKey('https://github.com/Acme/shop')).toBe('github.com/acme/shop');
    expect(sameRepoKey('ssh://git@github.com/acme/shop.git')).toBe('github.com/acme/shop');
    expect(sameRepoKey('https://token@github.com/acme/shop/')).toBe('github.com/acme/shop');
  });
});
