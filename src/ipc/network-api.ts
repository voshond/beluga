import { z } from 'zod';
import { EmojiSchema } from '../shared/reactions.js';

/**
 * The Beluga network's part of the API (see api.ts): friends, direct messages, groups and your
 * status. Only the Mac app shows it; the calls fail with a clear message while the network is off.
 * Browser-safe: zod only.
 */

const peerId = z.string().regex(/^[\w-]{32}$/);
const groupId = z.string().regex(/^[0-9a-f]{32}$/);
const name = z.string().trim().min(1).max(64);
const text = z.string().min(1).max(8_000);
const invitation = z.string().min(1).max(500);
const page = z.object({ before: z.number().int().optional(), limit: z.number().int().min(1).max(500).optional() });
const conversation = z.string().regex(/^(dm:[\w-]{32}|group:[0-9a-f]{32})$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const File = z.object({ sha, name: z.string().min(1).max(200), size: z.number().int().min(0), mime: z.string().max(100).optional(), image: z.boolean().optional() });
const Ask = z.union([z.literal('all'), z.array(peerId).min(1).max(100)]);
const Post = z.object({ text: z.string().max(8_000), files: z.array(File).max(20).optional(), ask: Ask.optional() });
const Presence = z.object({ state: z.enum(['online', 'away', 'dnd', 'offline']), note: z.string().max(140).optional(), emoji: z.string().max(32).optional(), until: z.number().int().positive().optional() });

export const NETWORK_API = {
  // Whether the network is on, and your peer id and address on it.
  'network.status': { args: z.tuple([]) },
  // Turn the network on or off now (and remember it in settings): → the new status.
  'network.setEnabled': { args: z.tuple([z.boolean()]) },
  'network.friends.list': { args: z.tuple([]) },
  // A one-time invitation: → { id, code, link, expiresAt }.
  'network.friends.invite': { args: z.tuple([]) },
  // Use a friend or group invitation (link or code): → who you're now friends with, or the group.
  'network.friends.accept': { args: z.tuple([invitation]) },
  'network.friends.cancelInvite': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/)]) },
  'network.friends.remove': { args: z.tuple([peerId]) },
  // Ask someone in your room to be friends: a one-time invitation only they may use, sent to them over the room: → { name }.
  'network.friends.addFromRoom': { args: z.tuple([peerId]) },
  // Answer a friend request someone in your room sent you (true: accept it, pairing your Macs): → who you're now friends with.
  'network.friends.answerOffer': { args: z.tuple([peerId, z.boolean()]) },
  'network.dm.send': { args: z.tuple([peerId, text]) },
  'network.dm.history': { args: z.tuple([peerId, page.optional()]) },
  'network.groups.list': { args: z.tuple([]) },
  'network.groups.create': { args: z.tuple([name, z.array(peerId).max(64).optional()]) },
  'network.groups.send': { args: z.tuple([groupId, text]) },
  'network.groups.history': { args: z.tuple([groupId, page.optional()]) },
  'network.groups.addMember': { args: z.tuple([groupId, peerId]) },
  'network.groups.removeMember': { args: z.tuple([groupId, peerId]) },
  'network.groups.setAdmin': { args: z.tuple([groupId, peerId, z.boolean()]) },
  'network.groups.leave': { args: z.tuple([groupId]) },
  // Delete a channel you've left from this Mac (the others keep their copies).
  'network.groups.delete': { args: z.tuple([groupId]) },
  'network.groups.rename': { args: z.tuple([groupId, name]) },
  // An invite link and code for a group (admins); `auto`: no approval needed.
  'network.groups.invite': { args: z.tuple([groupId, z.object({ auto: z.boolean().optional() }).optional()]) },
  'network.groups.join': { args: z.tuple([invitation]) },
  'network.groups.approve': { args: z.tuple([groupId, peerId]) },
  'network.groups.decline': { args: z.tuple([groupId, peerId]) },
  // `offline` means appear offline (you keep receiving).
  'network.presence.set': { args: z.tuple([Presence]) },
  'network.presence.get': { args: z.tuple([]) },
  // Your profile picture (base64 of a PNG, JPEG, WebP or GIF up to 96 KB; null takes it away): friends and people
  // in your groups get it once and keep it. → its checksum.
  'network.avatar.set': { args: z.tuple([z.string().max(140_000).nullable()]) },
  // A profile picture's bytes to show (a `PersonView.avatar` or `NetworkSelf.avatar`): → { mime, b64 }.
  'network.avatar.get': { args: z.tuple([sha]) },
  // Write in a conversation: text, files (added first with files.add / files.addData), and whose Claudes should answer.
  'network.post': { args: z.tuple([conversation, Post]) },
  // Take files in to share them (checksummed and cloned; folders are refused): → what a message says about each.
  'network.files.add': { args: z.tuple([z.array(z.string().min(1).max(4096)).min(1).max(20)]) },
  // Bytes without a file behind them (pasted media), base64, in parts of up to 4 MB (`part`: the upload's id, and
  // whether this is the last part; without it, the whole file in one): → the file once the last part is in.
  'network.files.addData': { args: z.tuple([z.string().min(1).max(200), z.string().max(7_600_000), z.object({ id: z.string().regex(/^[\w-]{8,64}$/), last: z.boolean() }).optional()]) },
  // Get a file shared in a conversation (big ones only come when asked).
  'network.files.download': { args: z.tuple([sha, conversation.optional()]) },
  'network.files.cancel': { args: z.tuple([sha]) },
  // Open it with its app, or show it in Finder.
  'network.files.open': { args: z.tuple([sha]) },
  'network.files.reveal': { args: z.tuple([sha]) },
  // Put a copy where you chose (Save As…): → where it went.
  'network.files.saveTo': { args: z.tuple([sha, z.string().min(1).max(4096)]) },
  // A picture's bytes to show in the chat: → { mime, b64 }.
  'network.files.preview': { args: z.tuple([sha]) },
  // Your main channel (a group with all your friends), made now if there isn't one: → its group id.
  'network.channels.main': { args: z.tuple([]) },
  // Delete a message from a direct conversation on this Mac; `everyone`: one of yours, from your friend's Mac too.
  'network.messages.delete': { args: z.tuple([conversation, z.string().regex(/^[\w-]{8,64}$/), z.object({ everyone: z.boolean().optional() }).optional()]) },
  // Change the text of a message you sent in a direct conversation (your friend sees it edited): → the message.
  'network.messages.edit': { args: z.tuple([conversation, z.string().regex(/^[\w-]{8,64}$/), text]) },
  // Put an emoji on a message, or take yours off (BLG-702): `true` puts it there, `false` takes it off, none flips
  // it. Your friend's Mac (or everyone in the group) sees it at once: → the message's reactions now.
  'network.messages.react': { args: z.tuple([conversation, z.string().regex(/^[\w-]{8,64}$/), EmojiSchema, z.boolean().optional()]) },
  // Empty a direct conversation on this Mac (your friend keeps their copy).
  'network.clear': { args: z.tuple([conversation]) },
  // Mark a conversation read: `dm:<peerId>` or `group:<id>`.
  'network.read': { args: z.tuple([conversation]) },
} as const;
