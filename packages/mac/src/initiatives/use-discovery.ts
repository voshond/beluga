import type { DiscoveryStep } from '@beluga/core/initiatives/discovery-model.js';
import { type InitiativeView, initiativeChatOf } from '@beluga/core/initiatives/model.js';
import { useInitiativeActions } from './use-initiatives.js';

/** A discovery step from the page: its prompt goes into the work chat, which the page then shows. */
export const useDiscoveryStep = (item: Pick<InitiativeView, 'slug' | 'chats'>) => {
  const a = useInitiativeActions();
  return async (step: DiscoveryStep, done: string): Promise<boolean> => {
    const sent = await a.act(() => a.api.discoveryStep(item.slug, step), done);
    if (!sent) return false;
    a.open(item, initiativeChatOf(sent.channel)?.chat);
    return true;
  };
};
