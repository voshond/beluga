import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * Harness marks (BLG-345): they show only when the chats listed run two or more harnesses, and they
 * are drawn in one quiet tone, never the makers' own colors, in light and dark. Screenshots go to
 * $BELUGA_SHOTS_DIR when it's set.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const shots = process.env.BELUGA_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png` });
  await page.waitForTimeout(1500);
}

/** The demo's project starts folded, with only the chat you're in. */
async function unfold(page: Page): Promise<void> {
  const show = sidebar(page).getByRole('button', { name: "Show what's in bob-api" }).first();
  if (await show.isVisible()) await show.click();
}

async function startParent(page: Page, name: string, threads: string): Promise<void> {
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await page.getByLabel('Worktree name').fill(name);
  await composer(page).fill(`start threads: ${threads}`);
  await page.getByRole('button', { name: /Create Worktree/ }).click();
  await expect(sidebar(page).getByRole('button', { name, exact: true })).toBeVisible({ timeout: 20_000 });
}

test.use({ video: shots ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off' });

test('one harness shows no mark; a second harness shows a quiet mark on each row, in light and dark', async ({ page, demo }) => {
  test.setTimeout(120_000);
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });
  await client.api.session.setPrefs({ agentThreads: true });
  client.close();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();

  // Every chat runs Claude: no marks, and the thread's row shows an agent's shape.
  await startParent(page, 'e2e-solo', 'solo=claude:keep working');
  await unfold(page);
  const fold = sidebar(page).getByRole('group', { name: 'Threads of e2e-solo' });
  await expect(fold.getByRole('button', { name: 'solo', exact: true })).toBeVisible({ timeout: 40_000 });
  await expect(sidebar(page).locator('[data-harness]')).toHaveCount(0);
  await shot(page, 'marks-01-one-harness-light');

  // A Codex thread: two harnesses, so each row shows its mark, in the quiet tone.
  await startParent(page, 'e2e-mixed', 'mixed=codex:keep working');
  const marks = sidebar(page).locator('[data-harness]');
  await expect(sidebar(page).locator('[data-harness="codex"]').first()).toBeVisible({ timeout: 40_000 });
  await expect(sidebar(page).locator('[data-harness="claude"]').first()).toBeVisible();
  for (const svg of await marks.locator('svg').all()) await expect(svg).toHaveAttribute('fill', 'currentColor');
  await shot(page, 'marks-02-mixed-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(sidebar(page).locator('[data-harness="codex"]').first()).toBeVisible();
  await shot(page, 'marks-03-mixed-dark');
});
