import type { Graph } from '@beluga/shared/graph-spec.js';
import type { ActionItem } from '../SpecMenu.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { composeWith } from '../../chat/compose-with.js';
import { sameDeep } from '../../lib/stable.js';
import { pictureName } from './graph-picture.js';

/**
 * Where a graph can go besides the clipboard: kept in an initiative as its JSON (drawn live on its
 * page), or its picture into the message box on screen to attach to a Jira ticket. That goes only
 * when you send it, and your agent attaches it with its Jira tools.
 */

type Initiative = { readonly slug: string; readonly name: string };

const errorText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error: /, '') : String(err));

export function useGraphShare({ graph, code, picture }: { graph: Graph; code: string; picture: () => Promise<Blob> }): ActionItem[] {
  const api = useApi();
  const { client } = useBeluga();
  const initiatives = useApp((st): readonly Initiative[] => (st.initiatives.enabled ? st.initiatives.items.filter((i) => i.status !== 'archived').map((i) => ({ slug: i.slug, name: i.name })) : []), sameDeep);
  const title = graph.title ?? 'Graph';

  const keepIn = (item: Initiative): void =>
    void api.initiatives.keepGraph(item.slug, code).then(
      () => toast(client, `Kept “${title}” in ${item.name}`, 'success'),
      (err: unknown) => toast(client, `Couldn’t keep the graph: ${errorText(err)}`, 'error'),
    );

  const attachToJira = (): void =>
    void picture().then(
      (png) => {
        const taken = composeWith({ files: [new File([png], pictureName(graph.title), { type: 'image/png' })], words: `Attach this picture of “${title}” to the Jira ticket ` });
        if (!taken) toast(client, 'Open a chat to attach it from', 'warn');
      },
      (err: unknown) => toast(client, `Couldn’t draw the picture: ${errorText(err)}`, 'warn'),
    );

  return [
    ...(initiatives.length ? [{ label: 'Keep in Initiative', icon: 'flag' as const, separate: true, submenu: initiatives.map((item) => ({ label: item.name, onSelect: () => keepIn(item) })), onSelect: () => undefined }] : []),
    { label: 'Attach to Jira Ticket…', icon: 'clip', ...(initiatives.length ? {} : { separate: true }), onSelect: attachToJira },
  ];
}
