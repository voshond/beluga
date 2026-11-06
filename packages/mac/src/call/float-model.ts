import type { CallView } from '../../../../src/shared/calls.js';

/**
 * What the floating call card shows (BLG-706): the window works it out and hands it over, so the
 * card's own window needs no connection to Beluga. Browser-safe and pure.
 */

export interface FloatPerson {
  readonly peerId: string;
  readonly name: string;
  readonly speaking: boolean;
  readonly muted: boolean;
}

export type FloatState =
  | { readonly kind: 'in'; readonly conversation: string; readonly place: string; readonly startedAt: number; readonly muted: boolean; readonly people: readonly FloatPerson[]; readonly sharing?: string; readonly youShare?: boolean }
  | { readonly kind: 'ringing'; readonly conversation: string; readonly place: string; readonly by: FloatPerson; readonly group: boolean };

export type FloatAction = 'mute' | 'unmute' | 'leave' | 'join' | 'decline' | 'open' | 'stop-sharing' | 'hide';

export const FLOAT_ACTIONS: readonly FloatAction[] = ['mute', 'unmute', 'leave', 'join', 'decline', 'open', 'stop-sharing', 'hide'];

/** The call you're in wins; else the oldest one ringing; else nothing (the card hides). */
export function floatState(mine: CallView | undefined, ringing: readonly CallView[], speaking: ReadonlySet<string>, placeOf: (conversation: string) => string): FloatState | null {
  if (mine) {
    const me = mine.people.find((p) => p.me);
    const sharer = mine.people.filter((p) => p.sharing).at(-1);
    return {
      kind: 'in',
      conversation: mine.conversation,
      place: placeOf(mine.conversation),
      startedAt: mine.startedAt,
      muted: me?.muted ?? false,
      people: mine.people.filter((p) => !p.me).map((p) => ({ peerId: p.peerId, name: p.name, speaking: speaking.has(p.peerId), muted: p.muted })),
      ...(sharer ? { sharing: sharer.me ? 'You' : sharer.name } : {}),
      ...(me?.sharing ? { youShare: true } : {}),
    };
  }
  const r = ringing[0];
  if (!r) return null;
  const by = r.people.find((p) => p.peerId === r.ringBy) ?? r.people[0];
  if (!by) return null;
  return { kind: 'ringing', conversation: r.conversation, place: placeOf(r.conversation), by: { peerId: by.peerId, name: by.name, speaking: false, muted: by.muted }, group: r.conversation.startsWith('group:') };
}

/**
 * The order of the faces on the card (peer ids), from the last order and who's in the call now
 * (BLG-743): whoever talks moves to the front and stays there after they stop, until someone else
 * talks; someone new comes in at the end. The card shows the first few, the front one on top.
 */
export function faceOrder(prev: readonly string[], people: ReadonlyArray<{ readonly peerId: string; readonly speaking: boolean }>): string[] {
  const here = new Set(people.map((p) => p.peerId));
  const kept = prev.filter((id) => here.has(id));
  const order = [...kept, ...people.map((p) => p.peerId).filter((id) => !kept.includes(id))];
  const talking = new Set(people.filter((p) => p.speaking).map((p) => p.peerId));
  return [...order.filter((id) => talking.has(id)), ...order.filter((id) => !talking.has(id))];
}
