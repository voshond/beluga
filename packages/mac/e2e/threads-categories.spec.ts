import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * Child threads with the sidebar categories on (BLG-332, BLG-333): a category row shows its harness
 * and holds the threads it started, as the project list does, and Remind Me Later hides a child from
 * under its parent until it reminds you. Screenshots go to $BELUGA_SHOTS_DIR when it's set.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const categories = (page: Page) => sidebar(page).locator('[role="region"]').filter({ has: page.locator('[data-category]') });
const shots = process.env.BELUGA_SHOTS_DIR;

/** A screenshot, and a beat on it so that the recording shows the same moment. */
async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${name}.png` });
  await page.waitForTimeout(1500);
}

test.use({ video: shots ? { mode: 'on', size: { width: 1440, height: 900 } } : 'off' });

test('a category row shows its harness and its child threads, and Remind Me Later hides a child', async ({ page, demo }) => {
  test.setTimeout(120_000);
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });
  await client.api.session.setPrefs({ agentThreads: true, chatCategories: true });
  client.close();
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().hover();
  await sidebar(page).getByRole('button', { name: 'New worktree in bob-api', exact: true }).click();
  await page.getByLabel('Worktree name').fill('e2e-lead');
  await composer(page).fill('start threads: kid-one=claude:keep working; kid-two=codex:keep working');
  await page.getByRole('button', { name: /Create Worktree/ }).click();

  // The parent's category row: its harness mark, and its threads under it.
  const lead = categories(page).getByRole('button', { name: /^e2e-lead · / });
  await expect(lead).toBeVisible({ timeout: 20_000 });
  await expect(lead.locator('[data-harness="claude"]')).toBeVisible();
  const group = categories(page).getByRole('group', { name: 'Threads of e2e-lead' });
  await expect(group.getByRole('button', { name: 'kid-one', exact: true })).toBeVisible({ timeout: 40_000 });
  await expect(group.getByRole('button', { name: 'kid-two', exact: true })).toBeVisible();
  // No child has a category row of its own.
  await expect(categories(page).getByRole('button', { name: /^kid-(one|two) · / })).toHaveCount(0);
  await shot(page, 'c1-category-nested');

  // Remind Me Later on a child: it leaves its parent's fold for Later.
  await group.getByRole('button', { name: 'kid-one', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remind Me Later' }).hover();
  await page.getByRole('menuitem', { name: /^In 1 Hour/ }).click();
  await expect(group.getByRole('button', { name: 'kid-one', exact: true })).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'kid-two', exact: true })).toBeVisible();
  const later = sidebar(page).getByRole('region', { name: 'Later' });
  const head = later.getByRole('button', { name: /^Later/ }).first();
  await expect(head).toBeVisible();
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  const put = later.getByRole('button', { name: /^kid-one · / });
  await expect(put).toBeVisible();
  await shot(page, 'c2-later-hides-child');

  // Its time ends (Show Again Now): back under its parent.
  await put.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Show Again Now/ }).click();
  await expect(group.getByRole('button', { name: 'kid-one', exact: true })).toBeVisible();
  await expect(categories(page).getByRole('button', { name: /^kid-one · / })).toHaveCount(0);
  await shot(page, 'c2-child-back');
});
