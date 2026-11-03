import { shortVersion } from '../../../../src/net/mesh/features.js';
import type { FriendOfferView, FriendView, GroupView, InvitationView, MemberView, MessageView, NetworkState, PersonView, Presence, PresenceState } from '../../../../src/net/mesh/views.js';

/**
 * What the Mac app's friends, groups and status screens say and decide, as plain functions
 * (no React, no daemon): labels, durations, invitations in pasted text, idle → away.
 */

export type Conversation = { readonly kind: 'dm'; readonly peerId: string } | { readonly kind: 'group'; readonly groupId: string };

/** `dm:<peerId>` or `group:<id>` → which one, or undefined for anything else. */
export function conversationOf(id: string): Conversation | undefined {
  if (/^dm:[\w-]{32}$/.test(id)) return { kind: 'dm', peerId: id.slice(3) };
  if (/^group:[0-9a-f]{32}$/.test(id)) return { kind: 'group', groupId: id.slice(6) };
  return undefined;
}

export const dmId = (peerId: string): string => `dm:${peerId}`;
export const groupId = (id: string): string => `group:${id}`;

/** What someone looks like right now: offline unless connected (appearing offline reads as offline too). */
export function shownState(p: Pick<PersonView, 'online' | 'presence'>): PresenceState {
  return p.online && p.presence.state !== 'offline' ? p.presence.state : 'offline';
}

export const STATE_LABEL: Record<PresenceState, string> = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb', offline: 'Offline' };

/** Your own choice reads differently: "offline" is something you appear as. */
export const CHOICE_LABEL: Record<PresenceState, string> = { online: 'Online', away: 'Away', dnd: 'Do Not Disturb', offline: 'Appear Offline' };

const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "until 3:30 PM", "until tomorrow, 9:00 AM", or nothing. */
export function untilLabel(until: number | undefined, now = Date.now()): string {
  if (!until || until <= now) return '';
  const day = startOfDay(until) - startOfDay(now);
  if (day === 0) return `until ${clock(until)}`;
  if (day <= DAY_MS + 3_600_000) return `until tomorrow, ${clock(until)}`;
  return `until ${new Date(until).toLocaleDateString([], { weekday: 'long' })}`;
}

/** A status's emoji and note together ("🌮 at lunch"), or '' when it has neither. */
export function statusText(p: Pick<Presence, 'emoji' | 'note'>): string {
  return [p.emoji?.trim(), p.note?.trim()].filter(Boolean).join(' ');
}

/** "Away · 🌮 at lunch", "Online", "Offline"; "Needs a Beluga update" when your Macs can't link because of it. */
export function presenceLine(p: Pick<PersonView, 'online' | 'presence' | 'update'>): string {
  if (p.update === 'them') return 'Offline to you · their Beluga needs an update';
  if (p.update === 'you') return 'Update Beluga to reach them';
  const state = shownState(p);
  const status = state !== 'offline' ? statusText(p.presence) : '';
  return [STATE_LABEL[state], status].filter(Boolean).join(' · ');
}

/** Their Beluga in words: "1.2.0", "1.1.0 · update needed", or "An older version" for Macs that don't say. */
export function belugaLine(p: Pick<PersonView, 'beluga' | 'update'>): string {
  const version = p.beluga ? shortVersion(p.beluga.version) : undefined;
  if (p.update === 'them') return `${version ?? 'An older version'} · they need to update to reach you`;
  if (p.update === 'you') return `${version ?? 'A newer version'} · update yours to reach them`;
  return version && version !== 'unknown' ? version : 'An older version (it doesn’t say)';
}

/** Your status in words, as your sidebar and the menu bar say it ("Do Not Disturb until 3:30 PM"). */
export function selfLine(presence: Presence, now = Date.now()): string {
  const until = untilLabel(presence.until, now);
  return [CHOICE_LABEL[presence.state] + (until ? ` ${until}` : ''), statusText(presence)].filter(Boolean).join(' · ');
}

// ---- how long a status lasts

export type Duration = 'hour' | 'tomorrow' | 'forever';

export const DURATIONS: ReadonlyArray<{ readonly id: Duration; readonly label: string }> = [
  { id: 'hour', label: 'For 1 Hour' },
  { id: 'tomorrow', label: 'Until Tomorrow' },
  { id: 'forever', label: 'Until I Change It' },
];

const DAY_MS = 24 * 60 * 60_000;
const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** When a status chosen "for 1 hour" / "until tomorrow" (9 in the morning) ends; forever: never. */
export function untilOf(duration: Duration, now = Date.now()): number | undefined {
  if (duration === 'hour') return now + 60 * 60_000;
  if (duration === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }
  return undefined;
}

/** The status to send: the state, the note (trimmed, kept to 140), and when it ends. */
export function presenceFor(state: PresenceState, opts: { note?: string; emoji?: string; duration?: Duration } = {}, now = Date.now()): Presence {
  const note = opts.note?.trim().slice(0, 140);
  const emoji = opts.emoji?.trim().slice(0, 32);
  const until = state === 'online' ? undefined : untilOf(opts.duration ?? 'forever', now);
  return { state, ...(note ? { note } : {}), ...(emoji ? { emoji } : {}), ...(until ? { until } : {}) };
}

// ---- invitations

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A typed code as Beluga reads it (case, dashes, spaces, O/0 and I/L/1 don't matter), or undefined. */
export function readCode(text: string): string | undefined {
  const compact = text
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return (compact.length === 12 || compact.length === 8) && [...compact].every((c) => CODE_ALPHABET.includes(c)) ? compact : undefined;
}

export interface FoundInvitation {
  /** What to hand to `network.friends.accept` (the link, or the code as typed). */
  readonly text: string;
  /** A group's invitation (beluga://join…); a code can be either, so it says friend. */
  readonly group: boolean;
}

/** A Beluga network invitation in some text (a pasted link, a code, a message with one in it). */
export function findInvitation(text: string): FoundInvitation | undefined {
  const link = /(?:beluga|klaud):\/\/(add|join)\/?(?:#[\w-]{22}(?![\w-])|\?code=[0-9A-Za-z%+-]{8,40})/.exec(text);
  if (link) return { text: link[0], group: link[1] === 'join' };
  const trimmed = text.trim();
  if (trimmed.length <= 20 && readCode(trimmed)) return { text: trimmed, group: false };
  return undefined;
}

/** "Expires in 23 hours", "Expires in 12 minutes", "Expired". */
export function expiryLabel(expiresAt: number, now = Date.now()): string {
  const left = expiresAt - now;
  if (left <= 0) return 'Expired';
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `Expires in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `Expires in ${days} days`;
}

/** "12 minutes", "23 hours", "3 days" (how long something still lasts). */
export function timeLeft(until: number, now = Date.now()): string {
  const label = expiryLabel(until, now);
  return label === 'Expired' ? 'no longer' : label.replace(/^Expires in /, '');
}

/** The friend invitation still worth showing (the newest unexpired one), if any. One made for someone in your room isn't yours to hand out. */
export function openFriendInvitation(invitations: readonly InvitationView[], now = Date.now()): InvitationView | undefined {
  return [...invitations].filter((i) => i.kind === 'friend' && !i.for && i.expiresAt > now && i.uses === 0).sort((a, b) => b.expiresAt - a.expiresAt)[0];
}

// ---- one people list (BLG-202): your room folds into Friends

/** Someone in your room, as the people list needs them. */
export interface RoomPerson {
  readonly peerId: string;
  readonly name: string;
  readonly agent?: boolean;
  readonly guest?: boolean;
  readonly host?: boolean;
}

/** What a friend's row says about them when they're in your room too: their Claude is on, you follow their screen. */
export interface RoomBits {
  readonly here: boolean;
  readonly claude: boolean;
  readonly following: boolean;
  /** Their index in the room's people (their room card and menu). */
  readonly index: number;
}

export function roomBits(peers: readonly RoomPerson[], peerId: string, follow: string | undefined): RoomBits | undefined {
  const index = peers.findIndex((p) => p.peerId === peerId && !p.guest);
  if (index < 0) return undefined;
  return { here: true, claude: peers[index]!.agent === true, following: follow === peerId, index };
}

/** People in your room who aren't friends yet (not you, and never guests: they came with a project link), by name. */
export function notFriendsYet(peers: readonly RoomPerson[], opts: { readonly selfId: string | undefined; readonly friends: readonly Pick<FriendView, 'peerId'>[]; readonly guests?: Readonly<Record<string, unknown>> }): Array<RoomPerson & { index: number }> {
  return peers
    .map((p, index) => ({ ...p, index }))
    .filter((p) => p.peerId !== opts.selfId && !p.guest && !opts.guests?.[p.peerId] && !opts.friends.some((f) => f.peerId === p.peerId))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.peerId.localeCompare(b.peerId));
}

/** Friend requests someone in your room sent you, oldest first. */
export const incomingOffers = (offers: readonly FriendOfferView[] | undefined): FriendOfferView[] => (offers ?? []).filter((o) => o.dir === 'in').sort((a, b) => a.at - b.at);

/** Whether you already asked this person (and they haven't answered yet). */
export const offerSent = (offers: readonly FriendOfferView[] | undefined, peerId: string, now = Date.now()): boolean => (offers ?? []).some((o) => o.dir === 'out' && o.peerId === peerId && o.expiresAt > now);

/**
 * After you join someone's room with an old room link: the host to offer as a friend ("Add kay as a
 * friend?"), unless they're one already, you asked them, they asked you, or you said not now.
 */
export function hostToBefriend(opts: { readonly peers: readonly RoomPerson[]; readonly selfId: string | undefined; readonly friends: readonly Pick<FriendView, 'peerId'>[]; readonly offers?: readonly FriendOfferView[]; readonly dismissed: ReadonlySet<string> }): RoomPerson | undefined {
  const me = opts.peers.find((p) => p.peerId === opts.selfId);
  if (!me || me.host || me.guest) return undefined;
  const host = opts.peers.find((p) => p.host && p.peerId !== opts.selfId);
  if (!host || opts.dismissed.has(host.peerId) || opts.friends.some((f) => f.peerId === host.peerId)) return undefined;
  if ((opts.offers ?? []).some((o) => o.peerId === host.peerId)) return undefined;
  return host;
}

/** A group's open invitation, if an admin made one. */
export function openGroupInvitation(invitations: readonly InvitationView[], id: string, now = Date.now()): InvitationView | undefined {
  return [...invitations].filter((i) => i.kind === 'group' && i.groupId === id && i.expiresAt > now).sort((a, b) => b.expiresAt - a.expiresAt)[0];
}

/** Errors from accepting an invitation, said for people (the core's own words when they're already clear). */
export function acceptError(message: string): string {
  if (/Nobody is waiting/i.test(message)) return 'That invitation expired or was already used. Ask for a new one.';
  if (/own invitation/i.test(message)) return 'That’s your own invitation. Send it to a friend instead.';
  if (/isn.t a (?:beluga|klaud) invitation/i.test(message)) return 'That doesn’t look like a Beluga invitation. Paste the link or type the code (like K7QM-4XPA-R2TD).';
  if (/network is off/i.test(message)) return 'Turn on talking with friends first.';
  return message.replace(/^Something went wrong: /, '');
}

// ---- lists and names

/** Friends in a steady order (by name), so rows don't jump when someone's status changes. */
export const sortFriends = (friends: readonly FriendView[]): FriendView[] => [...friends].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.peerId.localeCompare(b.peerId));

/** Groups you're in first (by name), then ones you left. */
export const sortGroups = (groups: readonly GroupView[]): GroupView[] => [...groups].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));

/** "bob, mia and you", "bob and 4 others". */
export function membersLine(members: readonly MemberView[], max = 3): string {
  const others = members.filter((m) => !m.self).map((m) => m.name);
  const you = members.some((m) => m.self);
  const names = [...others.slice(0, max), ...(you && others.length <= max ? ['you'] : [])];
  const rest = others.length - Math.min(others.length, max) + (you && others.length > max ? 1 : 0);
  if (rest > 0) return `${names.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
  if (names.length <= 1) return names[0] ?? 'Nobody yet';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Members in the order a group's info shows them: you, admins, then by name. */
export const sortMembers = (members: readonly MemberView[]): MemberView[] =>
  [...members].sort((a, b) => Number(b.self) - Number(a.self) || Number(b.admin) - Number(a.admin) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

/** Friends who could be added to a group (not in it yet). */
export const addableFriends = (friends: readonly FriendView[], group: Pick<GroupView, 'members'>): FriendView[] => sortFriends(friends.filter((f) => !group.members.some((m) => m.peerId === f.peerId)));

/** Unread messages across friends and groups (for the window's badge). */
export const totalUnread = (net: Pick<NetworkState, 'friends' | 'groups'>): number => net.friends.reduce((n, f) => n + f.unread, 0) + net.groups.reduce((n, g) => n + (g.active ? g.unread : 0), 0);

// ---- the conversation

/** "Today", "Yesterday", "Monday", or a date. */
export function dayLabel(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(ts).toLocaleDateString([], { weekday: 'long' });
  return new Date(ts).toLocaleDateString([], { month: 'long', day: 'numeric', ...(new Date(ts).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}

export const sameDay = (a: number, b: number): boolean => startOfDay(a) === startOfDay(b);

const GROUP_GAP_MS = 3 * 60_000;

/** A message that continues the one before it (same author, same day, shortly after): no name again. */
/** (A person's Claude is its own author: its answers don't run on from what they wrote, nor the other way round.) */
export const continues = (prev: MessageView | undefined, m: MessageView): boolean => Boolean(prev && prev.from === m.from && Boolean(prev.claude) === Boolean(m.claude) && sameDay(prev.ts, m.ts) && m.ts - prev.ts < GROUP_GAP_MS && prev.status !== 'locked' && m.status !== 'locked');

/** Earlier messages (from history) and the latest ones (from the shared state), once each, oldest first. */
export function mergeMessages(earlier: readonly MessageView[], latest: readonly MessageView[]): MessageView[] {
  const ids = new Set(latest.map((m) => m.id));
  return [...earlier.filter((m) => !ids.has(m.id)), ...latest];
}

export { unreadLine, unreadSince } from '../../../../src/shared/unread.js';

/** Close enough to the bottom of a log to count as there. */
const BOTTOM_SLACK = 48;

/**
 * Whether a log keeps following the bottom after it scrolled (`before`: where it was): at the
 * bottom it does; scrolled up, it stops; pushed by what grew under it (pictures loading), as it was.
 */
export function keepsFollowing(was: boolean, before: number, now: { readonly top: number; readonly height: number; readonly client: number }): boolean {
  if (now.height - now.top - now.client < BOTTOM_SLACK) return true;
  if (now.top < before) return false;
  return was;
}

// ---- away when idle

/** Minutes without using the Mac before your status turns to Away by itself. */
export const IDLE_AWAY_MS = 10 * 60_000;

/**
 * What the idle watcher should do: turn to Away when you've been idle a while and chose Online,
 * back to Online when you return (only if it was the watcher that made you Away).
 */
export function idleStep(opts: { readonly presence: Presence; readonly idleMs: number; readonly autoAway: boolean; readonly threshold?: number }): 'away' | 'online' | undefined {
  const threshold = opts.threshold ?? IDLE_AWAY_MS;
  if (opts.presence.state === 'online' && opts.idleMs >= threshold) return 'away';
  if (opts.autoAway && opts.presence.state === 'away' && opts.idleMs < threshold) return 'online';
  return undefined;
}

/**
 * Where the watcher remembers that it made you Away. Your status itself is kept by the core, so
 * this has to outlive the window too: after a reload or a relaunch you still come back Online.
 */
export const IDLE_AWAY_KEY = 'beluga.idleAway';

type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const localStore = (): KeyStore | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** Whether your Away is the watcher's doing (not one you chose). */
export function wasIdleAway(store: KeyStore | undefined = localStore()): boolean {
  try {
    return store?.getItem(IDLE_AWAY_KEY) === '1';
  } catch {
    return false;
  }
}

/** Mark Away as the watcher's (true) or yours (false: a status you picked is never undone). */
export function rememberIdleAway(on: boolean, store: KeyStore | undefined = localStore()): void {
  try {
    if (on) store?.setItem(IDLE_AWAY_KEY, '1');
    else store?.removeItem(IDLE_AWAY_KEY);
  } catch {
    // Storage full or blocked: the watcher just won't bring you back this time.
  }
}
