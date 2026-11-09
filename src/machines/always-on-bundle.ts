import { createHash, type Hash } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DeviceSetSync } from '../companion/protocol.js';
import { readJson, writeJson } from '../net/mesh/files.js';
import { Settings } from '../shared/settings-schema.js';
import { IDENTITY_FILE } from './identity-load.js';

/**
 * What moves when a computer becomes your Always On (BLG-796), and how it travels: your identity,
 * your friends network's files (friends, invitations, DMs and their outbox, reactions, read marks,
 * presence, groups with their logs, avatars) and the settings that are you on the network (your
 * name, trust levels, what friends may ask). Device keys, phones and the device set's own file
 * stay: each install keeps its own, and the set's roster rides along to be merged.
 *
 * On the link it is a run of `ao-part` frames (each file in order, in chunks) and one `ao-end` with
 * the identity, the settings, the set and each file's size and SHA-256. The side that takes it
 * stages everything under always-on-incoming/<stage>/ and checks it whole before saying ready;
 * nothing of the network it runs changes until the giver says commit (always-on.ts).
 */

export const NETWORK_FILES = ['friends.json', 'invitations.json', 'outbox.json', 'dm-changes.json', 'dm-reactions.json', 'reads.json', 'presence.json'] as const;
export const NETWORK_DIRS = ['dms', 'groups', 'avatars'] as const;
export { IDENTITY_FILE };
/** The settings that are you to friends: they follow your identity, and leave with it. */
export const CARRIED_SETTINGS = ['name', 'people', 'policy', 'askMeFor', 'askFreely', 'capabilities', 'mailbox', 'mailboxAfterMin'] as const;

const INCOMING = 'always-on-incoming';
/** Your network as your Always On last sent it (BLG-799): what this Mac stands in with if it's down for long. */
export const STANDBY = 'always-on-standby';
/** Raw bytes per part: well under a link frame (8 MB) once in base64. */
export const CHUNK_BYTES = 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const Stage = z.string().regex(/^[0-9a-f]{32}$/);
/** A path inside the network's files: one of them, or under one of its folders; never out of it. */
const RelPath = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !p.includes('\\') && !p.split('/').some((s) => s === '' || s === '.' || s === '..') && ((NETWORK_FILES as readonly string[]).includes(p) || (NETWORK_DIRS as readonly string[]).some((d) => p.startsWith(`${d}/`))), 'Not a network file');

export const CarriedSettings = Settings.pick({ name: true, people: true, policy: true, askMeFor: true, askFreely: true, capabilities: true, mailbox: true, mailboxAfterMin: true }).partial();
export type CarriedSettings = z.infer<typeof CarriedSettings>;

const FileEntry = z.object({ path: RelPath, size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) });

export const AoHello = z.object({
  t: z.literal('always-on'),
  op: z.enum(['take', 'give', 'commit', 'status', 'replica']),
  stage: Stage.optional(),
  from: z.string().max(64).optional(),
  /** A stand-in handing back (BLG-799): chat logs are merged with what the taker has, and it stops its own network first. */
  merge: z.boolean().optional(),
});
export const AoPart = z.object({ t: z.literal('ao-part'), path: RelPath, at: z.number().int().min(0), data: z.string().max(Math.ceil((CHUNK_BYTES * 4) / 3) + 8) });
export const AoEnd = z.object({
  t: z.literal('ao-end'),
  stage: Stage,
  /** Empty in a replica: your identity isn't sent again. */
  identity: z.string().max(4000),
  owner: z.string().min(1).max(200),
  replica: z.boolean().optional(),
  /** A stand-in handing back (BLG-848): what changed during the stand-in, key by key (standin-settings.ts reads it); `settings` is then empty. */
  changes: z.unknown().optional(),
  files: z.array(FileEntry).max(MAX_FILES),
  settings: CarriedSettings,
  devset: DeviceSetSync,
});
export const AoReady = z.object({ t: z.literal('ao-ready'), stage: Stage, peerId: z.string().max(200) });
export const AoNo = z.object({ t: z.literal('ao-no'), reason: z.string().max(500) });
export const AoCommit = z.object({ t: z.literal('ao-commit'), stage: Stage });
export const AoDone = z.object({ t: z.literal('ao-done'), peerId: z.string().max(200) });
export const AoStatus = z.object({ t: z.literal('ao-status'), here: z.boolean(), staged: z.boolean().optional() });
export const AoFrame = z.discriminatedUnion('t', [AoHello, AoPart, AoEnd, AoReady, AoNo, AoCommit, AoDone, AoStatus]);
export type AoFrame = z.infer<typeof AoFrame>;
export type AoEnd = z.infer<typeof AoEnd>;
export type AoPart = z.infer<typeof AoPart>;

export function parseAo(text: string): AoFrame | undefined {
  try {
    const parsed = AoFrame.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A link's first frame asks for a handover (Machines.accept routes it here). */
export const isAlwaysOnHello = (text: string): boolean => parseAo(text)?.t === 'always-on';

// ---- the giving side

function walk(dir: string, rel: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(path.join(dir, rel));
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (name.endsWith('.tmp')) continue;
    const child = `${rel}/${name}`;
    const st = statSync(path.join(dir, child), { throwIfNoEntry: false });
    if (st?.isDirectory()) walk(dir, child, out);
    else if (st?.isFile()) out.push(child);
  }
}

/** Every file of your friends network in `dir`, relative to it. */
export function networkFiles(dir: string): string[] {
  const out = NETWORK_FILES.filter((f) => statSync(path.join(dir, f), { throwIfNoEntry: false })?.isFile());
  const files: string[] = [...out];
  for (const d of NETWORK_DIRS) walk(dir, d, files);
  return files;
}

/** Send every network file as parts; resolves with each one's size and hash, for the end frame. */
export function sendParts(dir: string, send: (frame: AoPart) => void): Array<z.infer<typeof FileEntry>> {
  const entries: Array<z.infer<typeof FileEntry>> = [];
  const buf = Buffer.alloc(CHUNK_BYTES);
  for (const rel of networkFiles(dir)) {
    const hash = createHash('sha256');
    const fd = openSync(path.join(dir, rel), 'r');
    let at = 0;
    try {
      for (;;) {
        const n = readSync(fd, buf, 0, CHUNK_BYTES, at);
        if (n <= 0 && at > 0) break;
        const chunk = buf.subarray(0, n);
        hash.update(chunk);
        send({ t: 'ao-part', path: rel, at, data: chunk.toString('base64') });
        at += n;
        if (n < CHUNK_BYTES) break;
      }
    } finally {
      closeSync(fd);
    }
    entries.push({ path: rel, size: at, sha256: hash.digest('hex') });
  }
  return entries;
}

/** The settings that leave with your identity, as they are here (each on its own: one that doesn't read never holds up the rest). */
export function carriedFrom(settings: Partial<Record<(typeof CARRIED_SETTINGS)[number], unknown>>): CarriedSettings {
  const kept = CARRIED_SETTINGS.flatMap((k) => {
    const parsed = CarriedSettings.shape[k].safeParse(settings[k]);
    return parsed.success && parsed.data !== undefined ? [[k, parsed.data] as const] : [];
  });
  return Object.fromEntries(kept) as CarriedSettings;
}

/** Your identity and friends network leave this install: only after the other side has them whole. */
export function wipeNetwork(dir: string, how: { keepIdentity?: boolean } = {}): void {
  // A stand-in handing back keeps its own stand-in key (identity.json was never yours there, BLG-847).
  if (!how.keepIdentity) rmSync(path.join(dir, IDENTITY_FILE), { force: true });
  for (const f of NETWORK_FILES) rmSync(path.join(dir, f), { force: true });
  for (const d of NETWORK_DIRS) rmSync(path.join(dir, d), { recursive: true, force: true });
}

// ---- the taking side

const stageRoot = (dir: string, stage: string, folder = INCOMING): string => path.join(dir, folder, stage);

/**
 * A handover coming in: parts written as they arrive (in order, each file from 0), then checked
 * whole against the end frame. Kept on disk until a commit installs it or another handover replaces it.
 */
export class Staging {
  private readonly root: string;
  private readonly hashes = new Map<string, Hash>();
  private readonly sizes = new Map<string, number>();
  private total = 0;
  private broken?: string;

  constructor(
    dir: string,
    readonly stage: string,
    private readonly folder = INCOMING,
  ) {
    // One handover at a time: an older staged one is dropped (a replica is kept until a new one is whole).
    if (folder === INCOMING) rmSync(path.join(dir, INCOMING), { recursive: true, force: true });
    else rmSync(stageRoot(dir, stage, folder), { recursive: true, force: true });
    this.root = stageRoot(dir, stage, folder);
    mkdirSync(path.join(this.root, 'files'), { recursive: true, mode: 0o700 });
  }

  part(p: AoPart): void {
    if (this.broken) return;
    const size = this.sizes.get(p.path) ?? 0;
    if (p.at !== size) return void (this.broken = `${p.path} arrived out of order`);
    const bytes = Buffer.from(p.data, 'base64');
    this.total += bytes.length;
    if (this.total > MAX_TOTAL_BYTES || this.sizes.size > MAX_FILES) return void (this.broken = 'Too much to move');
    const file = path.join(this.root, 'files', p.path);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (size === 0) writeFileSync(file, bytes, { mode: 0o600 });
    else appendFileSync(file, bytes);
    const hash = this.hashes.get(p.path) ?? createHash('sha256');
    hash.update(bytes);
    this.hashes.set(p.path, hash);
    this.sizes.set(p.path, size + bytes.length);
  }

  /** Every file the end frame names arrived whole (and nothing else did): then the end is kept beside them. */
  finish(end: AoEnd): string | undefined {
    if (this.broken) return this.broken;
    if (end.stage !== this.stage) return 'That handover was for another one';
    const named = new Set(end.files.map((f) => f.path));
    for (const f of end.files) {
      if ((this.sizes.get(f.path) ?? 0) !== f.size) return `${f.path} arrived short`;
      const got = f.size === 0 && !this.hashes.has(f.path) ? createHash('sha256').digest('hex') : this.hashes.get(f.path)?.digest('hex');
      if (got !== f.sha256) return `${f.path} arrived changed`;
      if (f.size === 0 && !existsSync(path.join(this.root, 'files', f.path))) {
        mkdirSync(path.dirname(path.join(this.root, 'files', f.path)), { recursive: true, mode: 0o700 });
        writeFileSync(path.join(this.root, 'files', f.path), '', { mode: 0o600 });
      }
    }
    for (const p of this.sizes.keys()) if (!named.has(p)) return `${p} wasn't in the list`;
    writeJson(path.join(this.root, 'end.json'), end);
    return undefined;
  }
}

/** The end frame of a handover staged here and checked whole, if there is one. */
export function stagedEnd(dir: string, stage: string, folder = INCOMING): AoEnd | undefined {
  const parsed = AoEnd.safeParse(readJson(path.join(stageRoot(dir, stage, folder), 'end.json')));
  return parsed.success && parsed.data.stage === stage ? parsed.data : undefined;
}

/**
 * Put a staged network in place of whatever this install had (normally nothing), and drop the staging.
 * `merge` (a stand-in handing back, BLG-799): a chat log keeps every line either side has, in order,
 * the taker's first; every other file is the giver's (it's the newer).
 */
export function installStaged(dir: string, stage: string, how: { merge?: boolean } = {}): void {
  const files = path.join(stageRoot(dir, stage), 'files');
  if (how.merge) mergeLogs(dir, files);
  for (const f of NETWORK_FILES) {
    if (!existsSync(path.join(files, f))) continue;
    rmSync(path.join(dir, f), { force: true });
    renameSync(path.join(files, f), path.join(dir, f));
  }
  for (const d of NETWORK_DIRS) {
    if (!existsSync(path.join(files, d)) && how.merge) continue;
    rmSync(path.join(dir, d), { recursive: true, force: true });
    if (existsSync(path.join(files, d))) renameSync(path.join(files, d), path.join(dir, d));
  }
  dropStaged(dir);
}

/** Each staged chat log (*.jsonl) gets the lines only this install had, before its own (they're older); logs only here are kept. */
function mergeLogs(dir: string, files: string): void {
  const here: string[] = [];
  for (const d of NETWORK_DIRS) walk(dir, d, here);
  for (const rel of here.filter((p) => p.endsWith('.jsonl'))) {
    const staged = path.join(files, rel);
    const mine = readFileSync(path.join(dir, rel), 'utf8').split('\n').filter(Boolean);
    if (!existsSync(staged)) {
      mkdirSync(path.dirname(staged), { recursive: true, mode: 0o700 });
      writeFileSync(staged, mine.length ? `${mine.join('\n')}\n` : '', { mode: 0o600 });
      continue;
    }
    const theirs = readFileSync(staged, 'utf8').split('\n').filter(Boolean);
    const known = new Set(theirs);
    const missing = mine.filter((l) => !known.has(l));
    if (missing.length) writeFileSync(staged, `${[...missing, ...theirs].join('\n')}\n`, { mode: 0o600 });
  }
}

/** Copy a replica in place (it stays staged, for the next time). */
export function installReplica(dir: string, stage: string): void {
  const files = path.join(stageRoot(dir, stage, STANDBY), 'files');
  for (const f of NETWORK_FILES) {
    rmSync(path.join(dir, f), { force: true });
    if (existsSync(path.join(files, f))) cpSync(path.join(files, f), path.join(dir, f));
  }
  for (const d of NETWORK_DIRS) {
    rmSync(path.join(dir, d), { recursive: true, force: true });
    if (existsSync(path.join(files, d))) cpSync(path.join(files, d), path.join(dir, d), { recursive: true });
  }
}

/** The newest whole replica here (its stage), if any. */
export function latestReplica(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(path.join(dir, STANDBY));
  } catch {
    return undefined;
  }
  const whole = names.flatMap((stage) => {
    const end = stagedEnd(dir, stage, STANDBY);
    const at = end ? statSync(path.join(stageRoot(dir, stage, STANDBY), 'end.json')).mtimeMs : 0;
    return end ? [{ stage, at }] : [];
  });
  return whole.sort((a, b) => b.at - a.at)[0]?.stage;
}

/** Only the newest replica is kept. */
export function keepOnlyReplica(dir: string, stage: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(path.join(dir, STANDBY));
  } catch {
    return;
  }
  for (const n of names) if (n !== stage) rmSync(path.join(dir, STANDBY, n), { recursive: true, force: true });
}

export function dropReplicas(dir: string): void {
  rmSync(path.join(dir, STANDBY), { recursive: true, force: true });
}

export function dropStaged(dir: string): void {
  rmSync(path.join(dir, INCOMING), { recursive: true, force: true });
}

export const hasStaged = (dir: string, stage: string): boolean => stagedEnd(dir, stage) !== undefined;
