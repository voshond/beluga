import type { DomainState, View } from '../store.js';
import { initiativeChatOf, initiativeChatTitle, initiativeOf } from './model.js';

export type InitiativeChatFound = {
  readonly title: string;
  readonly kind: 'initiative';
  readonly view: View;
};

export const initiativeChatFound = (state: DomainState, channel: string): InitiativeChatFound | undefined => {
  const of = initiativeChatOf(channel);
  const item = of && state.initiatives ? initiativeOf(state.initiatives, of.slug) : undefined;
  if (!of || !item || !item.chats.chats.some((c) => c.channel === channel)) return undefined;
  return { title: `${item.name}: ${initiativeChatTitle(channel, state.log, 50)}`, kind: 'initiative', view: { kind: 'initiative_page', slug: of.slug, chat: of.chat } };
};
