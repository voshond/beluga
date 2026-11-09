import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Archiving and deleting a worktree take effect at once (the disk work follows in the
 * background), its right-click menu has Delete… beside Archive…, and the panel's Terminal and
 * Background sit in a dock of their own, folded to a slim bar.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const SHOTS = process.env.BELUGA_SHOTS ?? path.resolve(import.meta.dirname, '../../../.beluga/scratch');

async function showProject(page: Page, row: string): Promise<void> {
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  if (!(await sidebar(page).getByRole('button', { name: row, exact: true }).isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await expect(sidebar(page).getByRole('button', { name: row, exact: true })).toBeVisible();
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('Terminal and Background are a dock of their own, folded to a slim bar', async ({ page }) => {
  await showProject(page, 'add-auth');
  await sidebar(page).getByRole('button', { name: 'add-auth', exact: true }).click();
  const bottom = panel(page).locator('section[data-pane="bottom"]');
  await expect(bottom).toBeVisible();
  const top = panel(page).locator('section[data-pane="top"] > header');
  const dockHead = bottom.locator('header');
  // Its own background, not the top pane's.
  const bg = (sel: typeof top) => sel.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg(dockHead)).not.toBe(await bg(top));
  if (await panel(page).getByRole('button', { name: 'Show the terminal dock' }).isVisible()) await panel(page).getByRole('button', { name: 'Show the terminal dock' }).click();
  await expect(panel(page).getByRole('button', { name: 'Hide the terminal dock' })).toBeVisible();
  await panel(page).screenshot({ path: path.join(SHOTS, '03-dock-open.png') });
  await panel(page).getByRole('button', { name: 'Hide the terminal dock' }).click();
  await expect(panel(page).locator('#panel-body-bottom')).toHaveCount(0);
  const bar = (await dockHead.boundingBox())!;
  expect(bar.height).toBeLessThanOrEqual(30);
  await panel(page).screenshot({ path: path.join(SHOTS, '04-dock-folded.png') });
  // Clicking the bar itself opens it again.
  await dockHead.click({ position: { x: bar.width - 60, y: bar.height / 2 } });
  await expect(panel(page).locator('#panel-body-bottom')).toBeVisible();
});

test('a worktree’s right-click menu has Delete… beside Archive…; archiving takes it out of the sidebar at once', async ({ page }) => {
  await showProject(page, 'add-auth');
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  await row.click({ button: 'right' });
  const items = await page.getByRole('menuitem').allTextContents();
  expect(items).toEqual(expect.arrayContaining(['Archive…', 'Delete…']));
  expect(items.indexOf('Delete…')).toBe(items.indexOf('Archive…') + 1);
  await page.screenshot({ path: path.join(SHOTS, '01-worktree-menu-delete.png') });
  // A click event, not a pointer click: the demo's streaming keeps the sidebar, and so its menu, redrawing.
  await page.getByRole('menuitem', { name: 'Archive…' }).dispatchEvent('click');
  const alert = page.getByRole('alertdialog', { name: /Archive “add-auth”/ });
  await alert.getByRole('button', { name: 'Archive', exact: true }).click();
  // Gone right away, not "Archiving…" for as long as the disk takes.
  await expect(row).toHaveCount(0, { timeout: 400 });
  await page.screenshot({ path: path.join(SHOTS, '02-archived-at-once.png') });
});

test('Delete… asks, then the worktree leaves the sidebar at once', async ({ page }) => {
  await showProject(page, 'webhook-retries');
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…' }).dispatchEvent('click');
  const alert = page.getByRole('alertdialog', { name: /Delete “webhook-retries”/ });
  await expect(alert).toContainText('You can’t undo this');
  await alert.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row).toHaveCount(0, { timeout: 400 });
});
