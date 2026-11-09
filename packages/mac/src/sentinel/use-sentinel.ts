import { useMemo } from 'react';
import { CLAUDE_CHANGED, type RunSummary, type Sentinel, type SentinelDraft, type SentinelPatch, type SentinelState } from '@beluga/core/sentinel/model.js';
import type { Args } from '@beluga/ipc/api.js';
import type { View } from '@beluga/core/store.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { openSheet } from '../lib/sheets.js';
import { type ChatPlace, chatPlaceOf, runsFolderOf } from './sentinel-model.js';
import { openFolderThere } from '../lib/remote-open.js';

/** What Sentinel's screens share: the slice, and acting on sentinels with errors as toasts. */

export const useSentinelState = (): SentinelState => useApp((s) => s.sentinel);

const message = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error: /, '') : String(err));

export function useSentinelActions() {
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
        toast(client, message(err), 'error');
        return undefined;
      }
    };
    const go = (view: View): void => actions.run({ type: 'view', view });
    const openChat = (place: ChatPlace | undefined): void => {
      if (!place) return;
      if (place.kind === 'workspace') actions.run({ type: 'open_ws', id: place.id, tab: 'chat' });
      else go({ kind: 'assistant', ...(place.chat ? { chat: place.chat } : {}) });
    };
    const self = {
      api: api.sentinel,
      act,
      /** The model's types are readonly; the API's (from zod) aren't: the same shape. */
      create: (draft: SentinelDraft): Promise<Sentinel> => api.sentinel.create(draft as Args<'sentinel.create'>[0]),
      update: (id: string, patch: SentinelPatch): Promise<Sentinel> => api.sentinel.update(id, patch as Args<'sentinel.update'>[1]),
      openList: (projectId?: string): void => go({ kind: 'sentinel', ...(projectId ? { projectId } : {}) }),
      open: (id: string): void => go({ kind: 'sentinel_page', id }),
      openRun: (runId: string): void => go({ kind: 'sentinel_run', runId }),
      openChannel: (channel: string | undefined): void => openChat(chatPlaceOf(channel)),
      runNow: (s: Pick<Sentinel, 'id' | 'name'>): Promise<RunSummary | undefined> => act(() => api.sentinel.run(s.id), `${s.name} is running`),
      setPaused: (s: Pick<Sentinel, 'id' | 'name'>, paused: boolean): Promise<Sentinel | undefined> => act(() => api.sentinel.pause(s.id, paused), paused ? `${s.name} is paused` : `${s.name} is on`),
      duplicate: async (s: Pick<Sentinel, 'id' | 'name'>): Promise<void> => {
        const copy = await act(() => api.sentinel.duplicate(s.id), `Made a copy of ${s.name} (paused)`);
        if (copy) go({ kind: 'sentinel_page', id: copy.id });
      },
      remove: (s: Pick<Sentinel, 'id' | 'name'>, after?: () => void): void =>
        openSheet({
          kind: 'confirm',
          title: `Delete “${s.name}”?`,
          message: 'It stops watching, and a run going now stops. Its past runs’ reports go with the next clean-up. This can’t be undone.',
          confirm: 'Delete Sentinel',
          destructive: true,
          run: () => void act(() => api.sentinel.remove(s.id), `Deleted ${s.name}`).then(() => after?.()),
        }),
      /** Delete a run's chat, or the whole run (BLG-577), after asking. `after`: where to go once the run is gone. */
      deleteRun: (run: Pick<RunSummary, 'id' | 'headline'>, what: 'chat' | 'run', after?: () => void): void =>
        openSheet({
          kind: 'confirm',
          title: what === 'chat' ? 'Delete this run’s chat?' : 'Delete this run?',
          message:
            what === 'chat'
              ? 'Its agent’s conversation goes for good. The run, its report and its steps’ outputs stay here.'
              : 'Its agent’s conversation, its report, its steps’ outputs and its folder go for good. A worktree it made and numbers it kept stay.',
          confirm: what === 'chat' ? 'Delete Chat' : 'Delete Run',
          destructive: true,
          run: () => void act(async () => (await api.sentinel.runDelete(run.id, what), true), what === 'chat' ? 'Deleted the run’s chat' : 'Deleted the run').then((done) => done && what === 'run' && after?.()),
        }),
      copyJson: (s: Sentinel): void => void copyText(JSON.stringify(s, null, 2)).then(() => toast(client, `Copied ${s.name} as JSON`, 'success')),
      // A sentinel on a computer: its runs folder over Remote-SSH, else its path copied; never opened over there (BLG-852).
      openFolder: (path: string): void => void act(() => openFolderThere(client, path)),
    };
    return self;
  }, [api, client, actions]);
}

export type SentinelActions = ReturnType<typeof useSentinelActions>;

/** The runs folder, when the runs say where it is (memory-only runs don't). */
export const useRunsFolder = (): string | undefined => useApp((s) => runsFolderOf(s.sentinel.runs));

/** A sentinel's menu (right-click and ⋯ on its row): Run Now, Pause or Turn On, Open Last Run, Duplicate, Delete…. */
export function sentinelMenu(s: Sentinel, last: RunSummary | undefined, a: SentinelActions): ActionItem[] {
  return [
    { label: 'Run Now', icon: 'play', hint: s.paused ? 'Once, even though it’s paused' : undefined, onSelect: () => void a.runNow(s) },
    s.paused
      ? { label: s.pausedWhy && s.pausedWhy !== CLAUDE_CHANGED ? 'Resume' : 'Turn On', icon: 'play', hint: s.trigger.kind === 'schedule' ? 'It runs on its schedule from now' : undefined, onSelect: () => void a.setPaused(s, false) }
      : { label: 'Pause', icon: 'pause', hint: 'Nothing runs until you turn it on again', onSelect: () => void a.setPaused(s, true) },
    { label: 'Open Last Run', icon: 'arrowRight', disabled: !last, separate: true, onSelect: () => last && a.openRun(last.id) },
    { label: 'Duplicate', icon: 'copy', onSelect: () => void a.duplicate(s) },
    { label: 'Delete…', danger: true, separate: true, onSelect: () => a.remove(s) },
  ];
}
