import { z } from 'zod';

/** Shapes shared by the wire protocol, the group log and the files on disk (validated wherever they come in). */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const b64 = z.string().max(20_000).regex(/^[A-Za-z0-9+/=_-]*$/);

export const PeerIdSchema = z.string().regex(/^[\w-]{32}$/);
export const NameSchema = z.string().trim().min(1).max(64);

export const CardSchema = z.object({
  peerId: PeerIdSchema,
  publicKey: z.string().min(40).max(200),
  address: hex64,
  box: hex64,
  sig: b64,
});

export const PresenceSchema = z.object({
  state: z.enum(['online', 'away', 'dnd', 'offline']),
  note: z.string().max(140).optional(),
  /** One emoji (a flag or a family is several code points); a Mac from before it drops it. */
  emoji: z.string().max(32).optional(),
  until: z.number().int().positive().optional(),
});

export const SealedSchema = z.object({ epk: b64, iv: b64, ct: b64, tag: b64 });

/** Someone's card and the name they go by. */
export const ProfileSchema = z.object({ card: CardSchema, name: NameSchema });
export type Profile = z.infer<typeof ProfileSchema>;

export const ENTRY_TYPES = ['create', 'member_add', 'member_remove', 'admin_add', 'admin_remove', 'rename', 'sender_key', 'message'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** The most causal parents an entry names (concurrent heads beyond this merge on the next entry). */
export const MAX_PARENTS = 16;

export const EntrySchema = z.object({
  id: hex64,
  /** The group's id ('' for the entry that creates it). */
  group: z.string().regex(/^([0-9a-f]{32})?$/),
  author: PeerIdSchema,
  lamport: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  parents: z.array(hex64).max(MAX_PARENTS),
  type: z.enum(ENTRY_TYPES),
  ts: z.number().int().min(0),
  body: z.unknown(),
  sig: b64,
});
export type Entry = z.infer<typeof EntrySchema>;

export const BODIES = {
  create: z.object({ name: NameSchema, creator: ProfileSchema, nonce: z.string().max(64) }),
  member_add: z.object({ member: ProfileSchema }),
  member_remove: z.object({ peerId: PeerIdSchema }),
  admin_add: z.object({ peerId: PeerIdSchema }),
  admin_remove: z.object({ peerId: PeerIdSchema }),
  rename: z.object({ name: NameSchema }),
  /** A new sending key ("chain"), sealed for each member at the time. */
  sender_key: z.object({ chain: z.string().regex(/^[0-9a-f]{32}$/), basis: hex64, keys: z.record(PeerIdSchema, SealedSchema) }),
  message: z.object({ chain: z.string().regex(/^[0-9a-f]{32}$/), n: z.number().int().min(0).max(1_000_000), iv: b64, ct: b64, tag: b64 }),
} satisfies Record<EntryType, z.ZodType>;

export type Body<T extends EntryType> = z.infer<(typeof BODIES)[T]>;
