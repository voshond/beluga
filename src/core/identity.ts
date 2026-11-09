import type { KeyObject } from 'node:crypto';
import type { Identity } from '../net/crypto.js';

/**
 * Who this install is on the network, as the parts that may change hands read it (BLG-796): the
 * device set, the companion and the friends network. Making a computer your Always On moves your
 * identity there; the daemon that gave it away goes on with a stand-in key of its own, and the one
 * that took it becomes you, both without a restart. Each part reads `identity` when it needs it, so
 * a swap reaches all of them at once; the friends network is restarted around it (always-on.ts).
 *
 * Rooms keep the key they joined with: their hub checked it once, at the door.
 */
export interface SwappableIdentity {
  /** Always the current one: its fields are read through, never copied. */
  readonly identity: Identity;
  current(): Identity;
  swap(next: Identity): void;
}

export function swappableIdentity(initial: Identity): SwappableIdentity {
  let now = initial;
  const identity: Identity = {
    get publicKey(): string {
      return now.publicKey;
    },
    get privateKey(): KeyObject {
      return now.privateKey;
    },
    get peerId(): string {
      return now.peerId;
    },
  };
  return {
    identity,
    current: () => now,
    swap: (next) => {
      now = next;
    },
  };
}
