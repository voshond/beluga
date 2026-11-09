import type { Reaction } from '../../shared/reactions.js';
import type { Dm, DmStatus } from './dms.js';
import { extrasFields } from './extras.js';
import type { BelugaInfo } from './features.js';
import type { FriendRecord } from './friends.js';
import type { GroupEngine, ReadMessage } from './groups/engine.js';
import type { JoinRequest } from './groups/joins.js';
import { type InvitationRecord, codeLinkOf, formatCode, linkOf } from './invitations.js';
import type { MeshLink } from './link.js';
import { ONLINE } from './presence.js';
import { type FriendView, type GroupView, type InvitationView, type MessageView, type PersonView, type Presence, dmConversation, groupConversation } from './views.js';

/** Turning what the network keeps into the plain views screens get (views.ts). No secrets cross this line. */

export interface ViewContext {
  readonly me: string;
  readonly link: (peerId: string) => MeshLink | undefined;
  readonly presenceOf: (peerId: string) => Presence | undefined;
  readonly nameOf: (peerId: string) => string;
  /** Messages from others you've read, per conversation. */
  readonly readCount: (conversation: string) => number;
  /** What their Beluga said about itself on its last link (kept while they're away). */
  readonly belugaOf?: (peerId: string) => BelugaInfo | undefined;
  /** Your Macs speak different network versions: who needs to update. */
  readonly updateOf?: (peerId: string) => 'them' | 'you' | undefined;
  /** Their profile picture's checksum, once its bytes are here. */
  readonly avatarOf?: (peerId: string) => string | undefined;
}

export function person(ctx: ViewContext, peerId: string, name: string): PersonView {
  const link = ctx.link(peerId);
  const presence = link ? (ctx.presenceOf(peerId) ?? ONLINE) : { state: 'offline' as const };
  const beluga = ctx.belugaOf?.(peerId);
  const update = ctx.updateOf?.(peerId);
  const avatar = ctx.avatarOf?.(peerId);
  return { peerId, name, online: Boolean(link) && presence.state !== 'offline', presence, ...(link ? { via: link.via } : {}), ...(beluga ? { beluga } : {}), ...(update ? { update } : {}), ...(avatar ? { avatar } : {}) };
}

/** A message's reactions as a view's field: nothing when there are none. */
const reactionFields = (reactions: readonly Reaction[] | undefined): { reactions?: readonly Reaction[] } => (reactions?.length ? { reactions } : {});

export function dmView(ctx: ViewContext, peerId: string, dm: Dm, status: DmStatus, reactions?: readonly Reaction[]): MessageView {
  const mine = dm.from === ctx.me;
  const state = !mine ? undefined : status.seen.has(dm.id) ? 'seen' : status.delivered.has(dm.id) ? 'delivered' : status.expired.has(dm.id) ? 'expired' : 'waiting';
  return { id: dm.id, conversation: dmConversation(peerId), from: dm.from, name: mine ? 'you' : ctx.nameOf(dm.from), text: dm.text, ts: dm.ts, mine, ...extrasFields(dm.x), ...(state ? { status: state } : {}), ...(dm.edited ? { edited: dm.edited } : {}), ...reactionFields(reactions) };
}

export function groupMessageView(ctx: ViewContext, groupId: string, m: ReadMessage, reactions?: readonly Reaction[]): MessageView {
  const mine = m.entry.author === ctx.me;
  return {
    id: m.entry.id,
    conversation: groupConversation(groupId),
    from: m.entry.author,
    name: mine ? 'you' : ctx.nameOf(m.entry.author),
    text: m.text ?? '',
    ts: m.entry.ts,
    mine,
    ...extrasFields(m.extras),
    ...(m.text === undefined ? { status: 'locked' as const } : {}),
    ...reactionFields(reactions),
  };
}

const unread = (ctx: ViewContext, conversation: string, messages: readonly MessageView[]): number => Math.max(0, messages.filter((m) => !m.mine).length - ctx.readCount(conversation));

export function friendView(ctx: ViewContext, f: FriendRecord, messages: readonly MessageView[]): FriendView {
  const last = messages.at(-1);
  return { ...person(ctx, f.peerId, f.name), addedAt: f.addedAt, unread: unread(ctx, dmConversation(f.peerId), messages), ...(last ? { last } : {}) };
}

export function groupView(ctx: ViewContext, engine: GroupEngine, messages: readonly MessageView[], requests: readonly JoinRequest[]): GroupView | undefined {
  const model = engine.model;
  if (!model) return undefined;
  const last = messages.at(-1);
  const active = engine.isMember();
  return {
    id: model.id,
    name: model.name,
    members: [...model.members.values()].map((m) => ({ ...person(ctx, m.card.peerId, m.name), admin: m.admin, self: m.card.peerId === ctx.me, ...(m.card.peerId === ctx.me ? { online: true } : {}) })),
    admin: engine.isAdmin(),
    active,
    unread: unread(ctx, groupConversation(model.id), messages),
    ...(last ? { last } : {}),
    requests: active && engine.isAdmin() ? requests.map((r) => ({ peerId: r.profile.card.peerId, name: r.profile.name, ts: r.ts })) : [],
    createdAt: model.createdAt,
  };
}

export const invitationView = (r: InvitationRecord): InvitationView => ({
  id: r.id,
  kind: r.kind,
  ...(r.groupId ? { groupId: r.groupId } : {}),
  code: formatCode(r.code),
  link: linkOf(r),
  expiresAt: r.expiresAt,
  uses: r.uses,
  codeExpiresAt: r.codeExpiresAt,
  codeLink: codeLinkOf(r),
  ...(r.for ? { for: r.for } : {}),
});
