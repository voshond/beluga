import { expect, test } from './fixtures.js';

/** Running Beluga here (BLG-65): Settings › General offers Connect to a Server…, which opens the connect page. */

test('a local install can switch to a server from Settings', async ({ page }) => {
  await page.addInitScript(() => {
    const calls: string[] = [];
    const callbacks = new Map<number, (payload: { event: string; payload: string }) => void>();
    const listeners = new Map<string, number[]>();
    let next = 1;
    Object.assign(globalThis, {
      __shellCalls: calls,
      __menu: (id: string) => listeners.get('menu')?.forEach((cb) => callbacks.get(cb)?.({ event: 'menu', payload: id })),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
        transformCallback: (cb: (payload: { event: string; payload: string }) => void) => {
          callbacks.set(next, cb);
          return next++;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (cmd: string, args?: { event?: string; handler?: number }) => {
          calls.push(cmd);
          if (cmd === 'plugin:event|listen' && args?.event && args.handler) listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
          if (cmd === 'daemon_endpoint') return (await fetch('/__beluga/endpoint')).json();
          if (cmd === 'take_pending_links') return [];
          if (cmd === 'update_state') return { current: '0.0.0', mode: 'off', phase: 'current', waitingOn: [] };
          if (cmd === 'notification_access' || cmd === 'privacy_access') return {};
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.evaluate(() => (globalThis as unknown as { __menu: (id: string) => void }).__menu('settings'));
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();

  await settings.getByRole('button', { name: 'Connect to a Server…' }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __shellCalls: string[] }).__shellCalls)).toContain('client_change_server');
});
