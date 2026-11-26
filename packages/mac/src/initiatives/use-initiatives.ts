import { useMemo } from 'react';
import type { InitiativeDraft, InitiativePatch, InitiativeView } from '@beluga/core/initiatives/model.js';
import type { Args } from '@beluga/ipc/api.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useBeluga } from '../lib/beluga.js';

const messageOf = (err: Error | string): string => (err instanceof Error ? err.message.replace(/^Error: /, '') : err);

export const useInitiativeActions = () => {
  const api = useApi();
  const { client } = useBeluga();
  const actions = useActions();
  return useMemo(() => {
    const act = async <T,>(run: () => Promise<T>, done?: string): Promise<T | undefined> => {
      try {
        const result = await run();
        if (done) toast(client, done, 'success');
        return result;
      } catch (err) {
        toast(client, messageOf(err instanceof Error ? err : String(err)), 'error');
        return undefined;
      }
    };
    const openList = (): void => actions.run({ type: 'view', view: { kind: 'initiatives' } });
    const openPeople = (): void => actions.run({ type: 'view', view: { kind: 'initiative_people' } });
    const open = (item: Pick<InitiativeView, 'slug' | 'chats'>, chat?: string): void => actions.run({ type: 'view', view: { kind: 'initiative_page', slug: item.slug, chat: chat ?? item.chats.active } });
    const create = (draft: InitiativeDraft): Promise<{ readonly slug: string } | undefined> => act(() => api.initiatives.create(draft as Args<'initiatives.create'>[0]));
    const update = (slug: string, patch: InitiativePatch): Promise<InitiativeView | undefined> => act(() => api.initiatives.update(slug, patch as Args<'initiatives.update'>[1]));
    return {
      api: api.initiatives,
      act,
      openList,
      openPeople,
      open,
      create,
      update,
    };
  }, [api, client, actions]);
};

export type InitiativeActions = ReturnType<typeof useInitiativeActions>;
