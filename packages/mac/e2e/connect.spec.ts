import { type Page, expect, test } from '@playwright/test';

/** The connect page (BLG-51): Run here or a server on a fresh install, and Retry / Change server when it can't be reached. */

type Fake = { mode: 'local' | 'server' | null; serverUrl: string | null; reachable: boolean };

const withShell = async (page: Page, fake: Fake) => {
  await page.addInitScript((initial: Fake) => {
    const state = { ...initial, calls: [] as Array<{ cmd: string; args: Record<string, string> }> };
    Object.assign(globalThis, { __connect: state });
    const unreachable = 'Nothing answers at box.example.com:443. Is the server on, and is `beluga web` running there?';
    Object.assign(globalThis, {
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (cmd: string, args: Record<string, string>) => {
          state.calls.push({ cmd, args });
          if (cmd === 'client_config') return { mode: state.mode, serverUrl: state.serverUrl, deviceName: 'arch', defaultDeviceName: 'arch' };
          if (cmd === 'client_use_local') return null;
          if (cmd === 'client_open' || cmd === 'client_use_server') {
            if (!state.reachable) throw unreachable;
            return null;
          }
          throw `unknown command ${cmd}`;
        },
      },
    });
  }, fake);
  await page.goto('/connect.html');
};

const calls = (page: Page) => page.evaluate(() => (globalThis as unknown as { __connect: { calls: Array<{ cmd: string; args: Record<string, string> }> } }).__connect.calls);

test('a fresh install offers Run Beluga here and Connect to a server', async ({ page }) => {
  await withShell(page, { mode: null, serverUrl: null, reachable: true });
  await expect(page.getByRole('heading', { name: 'Welcome to Beluga' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Run Beluga here/ })).toBeVisible();
  await page.getByRole('button', { name: /Connect to a server/ }).click();

  const address = page.getByLabel('Server address');
  await address.fill('http://i9arch:7420');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Use an https:// address');
  expect((await calls(page)).some((c) => c.cmd === 'client_use_server')).toBe(false);

  await address.fill('i9arch.tail1234.ts.net/join/abc');
  await page.getByLabel('This device’s name').fill('m1arch');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(async () => (await calls(page)).find((c) => c.cmd === 'client_use_server')?.args).toEqual({ url: 'https://i9arch.tail1234.ts.net/join/abc', deviceName: 'm1arch' });
});

test('Run Beluga here asks the shell to run it here', async ({ page }) => {
  await withShell(page, { mode: null, serverUrl: null, reachable: true });
  await page.getByRole('button', { name: /Run Beluga here/ }).click();
  await expect.poll(async () => (await calls(page)).map((c) => c.cmd)).toContain('client_use_local');
});

test('an unreachable server offers Retry and Change server', async ({ page }) => {
  await withShell(page, { mode: 'server', serverUrl: 'https://box.example.com', reachable: false });
  await expect(page.getByRole('heading', { name: 'Can’t reach the server' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Nothing answers at box.example.com:443');

  const opens = async () => (await calls(page)).filter((c) => c.cmd === 'client_open').length;
  const before = await opens();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(opens).toBe(before + 1);
  await expect(page.getByRole('heading', { name: 'Can’t reach the server' })).toBeVisible();

  await page.getByRole('button', { name: 'Change server' }).click();
  await expect(page.getByLabel('Server address')).toHaveValue('https://box.example.com');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('button', { name: /Run Beluga here/ })).toBeVisible();
});
