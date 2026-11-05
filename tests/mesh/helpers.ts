import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { type Identity, generateIdentity } from '../../src/net/crypto.js';
import { Mesh, type MeshOptions } from '../../src/net/mesh/mesh.js';
import type { Timing } from '../../src/net/mesh/links.js';
import type { FriendView, GroupView, MessageView } from '../../src/net/mesh/views.js';
import { waitFor } from '../helpers.js';

/** Quick timings so people going offline and coming back takes milliseconds, not minutes. */
export const FAST: Timing = { dialTimeoutMs: 4_000, backoffMinMs: 100, backoffMaxMs: 400, pingMs: 250, syncMs: 400, pairTimeoutMs: 5_000 };

/**
 * Windows' CI runners are several times slower at git, processes and the local testnet (a demo
 * Mac alone can take 20 s there): network tests' waits and timeouts scale by this.
 */
export const SLOW = process.platform === 'win32' ? 3 : 1;

/**
 * Network tests that, on Windows' runners only, now and then wait for a message that never comes
 * while the rest of their file passes in a second (BLG-728; maybe two links to a friend closing
 * each other when the two Macs dial at once). They run on macOS and Linux until that's found.
 */
export const LOSES_A_MESSAGE_ON_WINDOWS = process.platform === 'win32';

/** How long a network condition may take to show up on a local testnet. */
export const SETTLE_MS = 15_000 * SLOW;

export const settle = <T>(fn: () => T | undefined | false | null): Promise<T> => waitFor(fn, SETTLE_MS);

/** One simulated person: their own identity and ~/.klaud, on the shared local testnet. */
export interface Person {
  readonly name: string;
  readonly identity: Identity;
  readonly dir: string;
  mesh: Mesh;
  /** Messages seen through the mesh's events (as a screen would). */
  readonly seen: MessageView[];
  /** Quit klaud (the Mac goes offline). */
  stop(): Promise<void>;
  /** Start klaud again with the same identity and files. */
  start(): Promise<void>;
  friend(peerId: string): FriendView | undefined;
  group(id: string): GroupView | undefined;
}

export interface Crowd {
  readonly testnet: Testnet;
  add(name: string, extra?: Partial<MeshOptions>): Promise<Person>;
  close(): Promise<void>;
}

export async function crowd(): Promise<Crowd> {
  const testnet = await createTestnet(3, { host: '127.0.0.1' });
  const people: Person[] = [];
  const add = async (name: string, extra: Partial<MeshOptions> = {}): Promise<Person> => {
    const identity = generateIdentity();
    const dir = mkdtempSync(path.join(os.tmpdir(), `klaud-mesh-${name}-`));
    const seen: MessageView[] = [];
    const boot = async (): Promise<Mesh> => {
      const mesh = await Mesh.start({ identity, name, dir, bootstrap: testnet.bootstrap, host: '127.0.0.1', timing: FAST, ...extra });
      mesh.on('message', (m) => seen.push(m));
      return mesh;
    };
    const p: Person = {
      name,
      identity,
      dir,
      mesh: await boot(),
      seen,
      stop: () => p.mesh.close(),
      start: async () => {
        p.mesh = await boot();
      },
      friend: (peerId) => p.mesh.summary().friends.find((f) => f.peerId === peerId),
      group: (id) => p.mesh.summary().groups.find((g) => g.id === id),
    };
    people.push(p);
    return p;
  };
  return {
    testnet,
    add,
    close: async () => {
      await Promise.all(people.map((p) => p.mesh.close()));
      await testnet.destroy();
    },
  };
}

/** Make two people friends with a one-time link, and wait until they're linked. */
export async function befriend(a: Person, b: Person): Promise<void> {
  const invite = await a.mesh.createInvite();
  await b.mesh.accept(invite.link);
  await settle(() => a.friend(b.identity.peerId)?.online && b.friend(a.identity.peerId)?.online);
}

export const texts = (p: Person, groupId: string): string[] => p.mesh.groupHistory(groupId, { limit: 500 }).map((m) => m.text);
