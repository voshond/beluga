import { request } from 'node:http';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';
import { expectPicked, optionLabels, pick, popup } from './helpers.js';

/**
 * Settings › Advanced › Web access (BLG-659): off by default; one switch, then how browsers reach
 * Beluga (this computer only, Tailscale when it's there, a public link); the join link as a QR with
 * Copy; the browsers let in, each with Remove. The demo daemon's Tailscale is e2e/fake-tailscale.mjs,
 * so picking it serves nothing real; its web port is a free one.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');
const TAILNET = 'demo-box.tail-e2e.ts.net';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

/** A request to the daemon's web port as a browser (or tailscaled) would make it. */
function ask(port: number, method: string, urlPath: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('Web access: off by default, then this computer, Tailscale, the join link as a QR, and Remove', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const pane = settings(page);
  await pane.getByRole('button', { name: 'Advanced', exact: true }).click();

  // Off until you turn it on: nothing else to pick.
  const toggle = pane.getByRole('switch', { name: 'Open Beluga in a browser' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(popup(pane, 'How browsers reach Beluga')).toHaveCount(0);

  // On: this computer only, and a join link as a QR with Copy.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const way = popup(pane, 'How browsers reach Beluga');
  await expectPicked(way, 'local');
  // Tailscale is offered once it's found (installed and logged in).
  await expect.poll(() => optionLabels(way)).toEqual(['This computer only', 'Tailscale', 'Public link']);
  await expect(pane.getByRole('img', { name: "Scan to open Beluga in your phone's browser" })).toBeVisible();
  const local = await pane.locator('code', { hasText: '/join#' }).textContent();
  expect(local).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/join#/);
  const port = Number(new URL(local!).port);
  await expect(pane.getByRole('button', { name: 'Copy' })).toBeVisible();

  // Tailscale: the same as `beluga web --tailscale`: the ts.net address, your login gets in without a link.
  await pick(pane, 'How browsers reach Beluga', 'Tailscale');
  await expectPicked(way, 'tailscale');
  await expect(pane.getByText(`https://${TAILNET}`, { exact: true })).toBeVisible();
  await expect(pane.getByText('Your own Tailscale login (kay@example.com) gets in without a link')).toBeVisible();
  await expect(pane.locator('code', { hasText: '/join#' })).toHaveText(new RegExp(`^https://${TAILNET.replace(/\./g, '\\.')}/join#`));
  // Let in: the app (here 503, "isn't built": the demo daemon serves no built UI), never the Ask page's 401.
  expect([200, 503]).toContain(await ask(port, 'GET', '/', { host: TAILNET, 'tailscale-user-login': 'kay@example.com', accept: 'text/html' }));
  expect(await ask(port, 'GET', '/', { host: TAILNET, 'tailscale-user-login': 'mia@example.com', accept: 'text/html' })).toBe(401);
  await page.screenshot({ path: path.join(SHOTS, 'blg-659-web-access-tailscale.png') });

  // A browser joins with a link; it's listed, and Remove signs it out.
  const secret = (await pane.locator('code', { hasText: '/join#' }).textContent())!.split('#')[1]!;
  const origin = `http://127.0.0.1:${port}`;
  expect(await ask(port, 'POST', '/join', { host: `127.0.0.1:${port}`, origin, 'content-type': 'application/json', 'user-agent': SAFARI }, JSON.stringify({ secret }))).toBe(200);
  await pane.getByRole('button', { name: 'New Link' }).click();
  const browsers = pane.getByRole('list', { name: 'Browsers let in' });
  await expect(browsers.getByRole('listitem')).toHaveCount(1);
  await expect(browsers).toContainText('Safari');
  await page.screenshot({ path: path.join(SHOTS, 'blg-659-web-access-sessions.png') });
  await browsers.getByRole('button', { name: /^Remove / }).click();
  await expect(browsers.getByRole('listitem')).toHaveCount(0);
  await expect(browsers).toContainText('No browsers yet.');

  // Back to this computer only: the tailnet name isn't answered any more.
  await pick(pane, 'How browsers reach Beluga', 'This computer only');
  await expectPicked(way, 'local');
  expect(await ask(port, 'GET', '/', { host: TAILNET, 'tailscale-user-login': 'kay@example.com' })).toBe(421);

  // Off: the port closes.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(popup(pane, 'How browsers reach Beluga')).toHaveCount(0);
  await expect(ask(port, 'GET', '/', { host: `127.0.0.1:${port}` })).rejects.toThrow();
});
