/// <reference path="./modules.d.ts" />
import b4a from 'b4a';
import sodium from 'sodium-universal';
import type { DeviceCert, DeviceRole, DeviceRoster, Forget } from './protocol.js';

/**
 * The cryptography both ends of a phone pairing do, written once for both: the Mac (pair.ts, in
 * Node) and the phone (client.ts, in Holepunch's Bare worklet). So it uses only sodium-universal
 * and b4a, which hyperdht brings and which run unchanged in both; nothing from Node.
 *
 * - A pairing's secret (the QR's 22 characters) turns into the temporary key pair the Mac listens
 *   on and a proof key, with keyed BLAKE2b; a typed code is stretched with Argon2id (64 MiB) first,
 *   as friend codes are with scrypt, so watching the DHT for it is useless in its 10 minutes.
 * - Proofs are keyed BLAKE2b over the Noise handshake hash: bound to that very connection.
 * - The device certificate is signed by your identity (Ed25519) and checked with sodium's
 *   crypto_sign_verify_detached: the identity's raw key is the last 32 bytes of its SPKI DER.
 * - The phone's own keys (device, link, box) all come from one 32-byte seed it keeps.
 */

type Bytes = Uint8Array;

/** Crockford base32, as friend codes: reads aloud, types without mix-ups. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 12;
/** A pairing (link and code) works this long, and for one phone. */
export const PAIR_TTL_MS = 10 * 60 * 1000;
/** Argon2id cost for codes: 64 MiB and 2 passes (~0.1-0.3 s on a Mac or a recent phone). */
const PWHASH = { ops: 2, mem: 64 * 1024 * 1024 } as const;

/** What the phone was given: the QR's secret, or the code typed in. */
/** A link may carry the Mac's relay (`?r=`), so pairing works where the DHT can't be reached. */
export type DeviceTicket = { readonly via: 'link'; readonly secret: string; readonly relay?: string } | { readonly via: 'code'; readonly code: string };

export const formatCode = (code: string): string => (code.match(/.{1,4}/g) ?? []).join('-');
export const deviceLink = (secret: string, relay?: string): string => `beluga://device#${secret}${relay ? `?r=${encodeURIComponent(relay)}` : ''}`;

/** A typed code read loosely: any case, dashes or spaces, O for 0, I or L for 1. */
export function readCode(typed: string): string | undefined {
  const compact = typed.trim().toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return compact.length === CODE_LENGTH && [...compact].every((c) => CODE_ALPHABET.includes(c)) ? compact : undefined;
}

/** A pairing out of what was scanned, pasted or typed (`beluga://device#…`, `beluga://device?code=…`, `K7QM-4XPA-R2TD`). */
export function parseDeviceTicket(text: string): DeviceTicket | undefined {
  const link = /(?:beluga|klaud):\/\/device\/?#([\w-]{22})(?![\w-])(?:\?r=([\w%.-]+))?/.exec(text);
  if (link) {
    let relay: string | undefined;
    try {
      relay = link[2] ? decodeURIComponent(link[2]) : undefined;
    } catch {
      relay = undefined;
    }
    return { via: 'link', secret: link[1]!, ...(relay && /^wss?:\/\//.test(relay) ? { relay } : {}) };
  }
  const codeLink = /(?:beluga|klaud):\/\/device\/?\?code=([0-9A-Za-z%+-]{12,40})/.exec(text);
  const code = readCode(codeLink ? codeLink[1]!.replace(/%2D/gi, '-').replace(/\+/g, ' ') : text);
  return code ? { via: 'code', code } : undefined;
}

/** Whose pairing a secret is for: a phone's (`beluga://device`) or a computer's (`beluga://computer`, BLG-774). */
export type PairKind = 'device' | 'computer';

export const computerLink = (secret: string, relay?: string): string => `beluga://computer#${secret}${relay ? `?r=${encodeURIComponent(relay)}` : ''}`;

/** A computer's pairing out of what was pasted or typed (`beluga://computer#…`, or its code); a phone's link is not one. */
export function parseComputerTicket(text: string): DeviceTicket | undefined {
  const link = /beluga:\/\/computer\/?#([\w-]{22})(?![\w-])(?:\?r=([\w%.-]+))?/.exec(text);
  if (!link) return /:\/\/device/.test(text) ? undefined : parseDeviceTicket(text);
  let relay: string | undefined;
  try {
    relay = link[2] ? decodeURIComponent(link[2]) : undefined;
  } catch {
    relay = undefined;
  }
  return { via: 'link', secret: link[1]!, ...(relay && /^wss?:\/\//.test(relay) ? { relay } : {}) };
}

const utf8 = (s: string): Bytes => b4a.from(s, 'utf8');

/** base64url (the secret) without Node's Buffer encodings, which Bare's b4a may not have. */
export function fromBase64url(s: string): Bytes {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return b4a.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64');
}
export const toBase64url = (b: Bytes): string => b4a.toString(b, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Keyed BLAKE2b-256: our KDF and MAC. */
function blake(key: Bytes, ...parts: Bytes[]): Bytes {
  const out = b4a.alloc(32);
  sodium.crypto_generichash(out, b4a.concat(parts), key);
  return out;
}

/** The temporary key pair seed and the proof key a pairing's secret (or code) turns into. */
export interface DeviceSecrets {
  readonly seed: Bytes;
  readonly auth: Bytes;
}

/**
 * A pairing's keys. `kind` keeps a computer's pairing (BLG-774) apart from a phone's: the same code
 * typed for the other kind finds nothing.
 */
export async function deviceSecrets(ticket: DeviceTicket, kind: PairKind = 'device'): Promise<DeviceSecrets> {
  if (ticket.via === 'code') {
    const out = b4a.alloc(64);
    const salt = b4a.alloc(16);
    sodium.crypto_generichash(salt, utf8(`beluga-${kind}-code-v1`));
    const pw = utf8(ticket.code);
    if (typeof sodium.crypto_pwhash_async === 'function') await sodium.crypto_pwhash_async(out, pw, salt, PWHASH.ops, PWHASH.mem, sodium.crypto_pwhash_ALG_ARGON2ID13);
    else sodium.crypto_pwhash(out, pw, salt, PWHASH.ops, PWHASH.mem, sodium.crypto_pwhash_ALG_ARGON2ID13);
    return { seed: out.subarray(0, 32), auth: out.subarray(32) };
  }
  const ikm = fromBase64url(ticket.secret);
  if (ikm.length !== 16) throw new Error('That pairing link is incomplete');
  return { seed: blake(ikm, utf8(`beluga-${kind}-link-v1:seed`)), auth: blake(ikm, utf8(`beluga-${kind}-link-v1:auth`)) };
}

/** An Ed25519 key pair from a seed (what hyperdht's DHT.keyPair(seed) makes: a Noise key pair). */
export function signKeyPair(seed: Bytes): { publicKey: Bytes; secretKey: Bytes } {
  const publicKey = b4a.alloc(32);
  const secretKey = b4a.alloc(64);
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
  return { publicKey, secretKey };
}

/** Who sends a proof: a phone and the Mac pairing it, or an app and the computer it joins (BLG-774). */
export type Role = 'phone' | 'mac' | 'app' | 'computer';

/** What one side of a pairing sends to prove it holds the secret: bound to its role, this connection and what it says. */
export const devProof = (auth: Bytes, role: Role, handshakeHash: Bytes, about: string): string =>
  b4a.toString(blake(auth, utf8(`beluga-device-v1:${role}:`), handshakeHash, utf8(':'), utf8(about)), 'base64');

export function checkDevProof(auth: Bytes, role: Role, handshakeHash: Bytes, about: string, proof: string): boolean {
  const expected = blake(auth, utf8(`beluga-device-v1:${role}:`), handshakeHash, utf8(':'), utf8(about));
  let actual: Bytes;
  try {
    actual = b4a.from(proof, 'base64');
  } catch {
    return false;
  }
  return actual.length === expected.length && sodium.sodium_memcmp(actual, expected);
}

/** 64 pictures that are easy to tell apart and to name ("cat, rocket, cherry, anchor"). */
export const FINGERPRINT_EMOJI = [
  '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐢', '🐙',
  '🦋', '🐝', '🐳', '🦄', '🌵', '🌲', '🌻', '🍄', '🌙', '⭐', '🔥', '🌈', '❄️', '🌊', '⚡', '☂️',
  '🍎', '🍋', '🍒', '🍇', '🍉', '🥕', '🌽', '🍕', '🍩', '🧁', '☕', '🎈', '🎁', '🎸', '🥁', '🎲',
  '⚽', '🏀', '🚀', '🚲', '⛵', '🚂', '🏠', '⏰', '🔑', '🔔', '💡', '📚', '✏️', '⚓', '🧲', '💎',
] as const;

/**
 * The four pictures both screens show while you decide ("Pair Kayra's Pixel 9?"): a hash of the
 * phone's link key, the pairing's key and this connection's handshake, so a different phone (or
 * someone in the middle) shows different ones.
 */
export function fingerprint(handshakeHash: Bytes, phoneLink: Bytes, pairingKey: Bytes): string {
  const h = blake(utf8('beluga-device-fingerprint-v1'), handshakeHash, phoneLink, pairingKey);
  return [0, 1, 2, 3].map((i) => FINGERPRINT_EMOJI[h[i]! & 63]).join(' ');
}

/** JSON with keys in a fixed order (as net/mesh/files.ts `canonical`), so both ends sign and hash the same bytes. */
export function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('Too deeply nested');
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, depth + 1)}`).join(',')}}`;
}

export const CERT_LABEL = 'beluga-device-v1';

/** What the identity signs for a device: `beluga-device-v1:` + the canonical JSON of the certificate without its signature (keys.ts signText's format). */
export const certText = (cert: Omit<DeviceCert, 'sig'> & { sig?: string }): string => {
  const { sig: _sig, ...rest } = cert;
  return `${CERT_LABEL}:${canonical(rest)}`;
};

/** An identity's raw Ed25519 public key from its base64 SPKI DER (the last 32 bytes). */
export function rawIdentityKey(spkiBase64: string): Bytes | undefined {
  try {
    const der = b4a.from(spkiBase64, 'base64');
    return der.length === 44 ? der.subarray(12) : undefined;
  } catch {
    return undefined;
  }
}

/** A peer id from an identity key (crypto.ts peerIdFor: SHA-256, base64url, 32 characters). */
export function peerIdOf(spkiBase64: string): string {
  const out = b4a.alloc(32);
  sodium.crypto_hash_sha256(out, b4a.from(spkiBase64, 'base64'));
  return toBase64url(out).slice(0, 32);
}

/** What a certificate says its device is: one without a role is a phone's (signed before roles). */
export const roleOf = (cert: Pick<DeviceCert, 'role'>): DeviceRole => cert.role ?? 'phone';

/** A phone is android or ios, and nothing else is: a phone can't pass as an app, nor an app as a phone. */
export const roleFits = (cert: Pick<DeviceCert, 'role' | 'platform'>): boolean => (roleOf(cert) === 'phone') === (cert.platform === 'android' || cert.platform === 'ios');

/** An Ed25519 signature (base64) over `text` by `publicKey`. */
function verifySig(publicKey: Bytes, text: string, signature: string): boolean {
  try {
    const sig = b4a.from(signature, 'base64');
    return sig.length === 64 && publicKey.length === 32 && sodium.crypto_sign_verify_detached(sig, utf8(text), publicKey);
  } catch {
    return false;
  }
}

/** A certificate is genuine: its owner's peer id comes from its key, that key signed it, and its role fits its platform. */
export function verifyCert(cert: DeviceCert): boolean {
  try {
    const pk = rawIdentityKey(cert.ownerKey);
    if (!pk || peerIdOf(cert.ownerKey) !== cert.owner || !roleFits(cert)) return false;
    return verifySig(pk, certText(cert), cert.sig);
  } catch {
    return false;
  }
}

// ---- your device set (BLG-774)

export const ROSTER_LABEL = 'beluga-devset-v1';
export const FORGET_LABEL = 'beluga-forget-v1';

/** What the identity signs for the device set: its label + the canonical JSON without its signature. */
export const rosterText = (roster: Omit<DeviceRoster, 'sig'> & { sig?: string }): string => {
  const { sig: _sig, ...rest } = roster;
  return `${ROSTER_LABEL}:${canonical(rest)}`;
};

export const forgetText = (f: Omit<Forget, 'sig'> & { sig?: string }): string => {
  const { sig: _sig, ...rest } = f;
  return `${FORGET_LABEL}:${canonical(rest)}`;
};

/** A device set is genuine: its owner signed it, and every certificate in it is the owner's and genuine. */
export function verifyRoster(roster: DeviceRoster): boolean {
  const pk = rawIdentityKey(roster.ownerKey);
  if (!pk || peerIdOf(roster.ownerKey) !== roster.owner || !verifySig(pk, rosterText(roster), roster.sig)) return false;
  return roster.devices.every((c) => c.owner === roster.owner && c.ownerKey === roster.ownerKey && verifyCert(c));
}

/** A forget is genuine when its signer signed it: the owner's identity, or the device key it names. */
export function verifyForget(f: Forget, ownerKey: string): boolean {
  const pk = f.by === 'identity' ? rawIdentityKey(ownerKey) : fromHex(f.by);
  return Boolean(pk) && verifySig(pk!, forgetText(f), f.sig);
}

/** Sign `text` with a device's own Ed25519 secret key (base64). */
export function signWith(secretKey: Bytes, text: string): string {
  const sig = b4a.alloc(64);
  sodium.crypto_sign_detached(sig, utf8(text), secretKey);
  return b4a.toString(sig, 'base64');
}

/** A computer shows it holds a key it names: that key signs this connection's handshake. */
export const keyProofText = (which: 'device' | 'link', handshakeHash: Bytes): string => `beluga-computer-keys-v1:${which}:${hex(handshakeHash)}`;
export const checkKeyProof = (which: 'device' | 'link', handshakeHash: Bytes, keyHex: string, signature: string): boolean => verifySig(fromHex(keyHex), keyProofText(which, handshakeHash), signature);

/** The phone's keys, from the one seed it keeps (in the Android Keystore-wrapped store). */
export interface DeviceKeys {
  /** Its own Ed25519 key: who the phone is. */
  readonly device: { readonly publicKey: Bytes; readonly secretKey: Bytes };
  /** The Noise key pair it dials with (what the Mac's firewall lets in). */
  readonly link: { readonly publicKey: Bytes; readonly secretKey: Bytes };
  /** X25519, for what the Mac seals to it (pushes). */
  readonly box: { readonly publicKey: Bytes; readonly secretKey: Bytes };
}

export function deviceKeys(seed: Bytes): DeviceKeys {
  if (seed.length !== 32) throw new Error('A device seed is 32 bytes');
  const device = signKeyPair(blake(seed, utf8('beluga-device-key-v1')));
  const link = signKeyPair(blake(seed, utf8('beluga-device-link-v1')));
  const boxSeed = blake(seed, utf8('beluga-device-box-v1'));
  const box = { publicKey: b4a.alloc(32), secretKey: b4a.alloc(32) };
  sodium.crypto_box_seed_keypair(box.publicKey, box.secretKey, boxSeed);
  return { device, link, box };
}

/** A fresh 32-byte seed (the phone makes one when it's first set up). */
export function newSeed(): Bytes {
  const seed = b4a.alloc(32);
  sodium.randombytes_buf(seed);
  return seed;
}

export const hex = (b: Bytes): string => b4a.toString(b, 'hex');
export const fromHex = (s: string): Bytes => b4a.from(s, 'hex');
