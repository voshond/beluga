import { useCallback, useMemo } from 'react';
import type { PreviewResult } from '@beluga/shared/preview/opened.js';
import { atPreviewOrigin } from '../components/preview/preview-model.js';
import { toast, useBeluga } from './beluga.js';
import { webPreviewOrigin } from './boot.js';
import { revealTerminal } from './panel.js';
import { openExternal } from './system.js';

/**
 * A worktree's dev servers, from the Ports tab and a dev page's preview: open one in your browser,
 * stop it, follow what it prints.
 *
 * From another computer (the app as a client, a browser on the web port), a server on the computer
 * Beluga runs on opens through the preview origin's dev proxy (src/preview/dev-proxy.ts): it reaches
 * the server as localhost, so Vite's allowedHosts and a server listening on 127.0.0.1 only don't
 * matter. Each open asks for a fresh one-time ticket (the frame used its own).
 */

/** Where a dev page opens in the browser from here: through the preview origin when there is one, else its address on the network, else as it is. */
export async function devPageUrl(open: (wsId: string, spec: { target: { kind: 'url'; url: string } }) => Promise<unknown>, wsId: string, url: string): Promise<string> {
  const origin = webPreviewOrigin();
  if (!origin) return url;
  const opened = (await open(wsId, { target: { kind: 'url', url } }).catch(() => undefined)) as PreviewResult | undefined;
  if (!opened?.ok || opened.kind !== 'url') return url;
  const proxied = opened.via ? atPreviewOrigin(opened, origin) : undefined;
  if (proxied?.ok) return proxied.url;
  return opened.lan ?? url;
}

export interface DevServerActions {
  readonly open: (url: string) => void;
  readonly stop: (port: number) => void;
  readonly follow: (port: number) => void;
}

export function useDevServer(wsId: string): DevServerActions {
  const { client, ui } = useBeluga();
  const open = useCallback((url: string) => void devPageUrl((id, spec) => client.api.preview.open(id, spec), wsId, url).then(openExternal), [client, wsId]);
  const stop = useCallback(
    (port: number) =>
      void client.api.workspaces.stopPort(wsId, port).then(
        (stopped) => toast(client, stopped ? `Stopped the server on port ${port}` : `Nothing of this worktree’s listens on port ${port}`, stopped ? 'success' : 'warn'),
        (err: unknown) => toast(client, `Couldn’t stop it: ${err instanceof Error ? err.message : String(err)}`, 'error'),
      ),
    [client, wsId],
  );
  const follow = useCallback(
    (port: number) =>
      void client.api.workspaces.followPort(wsId, port).then((key) => {
        if (typeof key !== 'string') return toast(client, `The server on port ${port} doesn’t write its output to a file here: it runs in a terminal, or wasn’t started by Beluga`, 'warn');
        ui.patch({ termKey: key });
        if (!revealTerminal(client.store.getState(), true)) toast(client, 'No terminal here', 'warn');
      }),
    [client, ui, wsId],
  );
  return useMemo(() => ({ open, stop, follow }), [open, stop, follow]);
}
