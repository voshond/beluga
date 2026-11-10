import { expect, test, type Page } from './fixtures.js';

/** A calm sidebar: its places at the top; Search, Usage and the terminal elsewhere, one click or key away. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the top of the sidebar is Your Mac, Overview, Work (tasks, issues and actions), Plans, Sentinel and Files', async ({ page }) => {
  // The places themselves: a running plan's row sits under Plans (KLD-18) and isn't one of them, nor are the
  // sentinels listed under Sentinel (their rows, runs and fold toggles).
  const notPlaces = ':not([data-plan-row]):not([data-sentinel-side]):not([data-sentinel-side] *):not([data-sentinel-run]):not([aria-label^="Show all "]):not([aria-label^="Show only the sentinels"])';
  const top = sidebar(page).locator('section').first().getByRole('button').and(page.locator(notPlaces));
  await expect(top.nth(0)).toHaveAccessibleName(/^Your Mac/);
  await expect(top.nth(1)).toHaveAccessibleName(/^Overview/);
  await expect(top.nth(2)).toHaveAccessibleName(/^Work/);
  await expect(top.nth(3)).toHaveAccessibleName(/^Plans/);
  await expect(top.nth(4)).toHaveAccessibleName(/^Sentinel/);
  // The room's chat is no place up here (BLG-871): its group chat is under Channels.
  await expect(sidebar(page).locator('section').first().getByRole('button', { name: /^(Chat|Group chat)/ })).toHaveCount(0);
  await expect(sidebar(page).locator('section').first().getByRole('button', { name: /^Files/ })).toBeVisible();
  for (const gone of ['Search', 'Usage', 'Terminal']) await expect(sidebar(page).locator('section').first().getByRole('button', { name: gone, exact: true })).toHaveCount(0);
});

test('Search from the toolbar, Usage from the icon above the sidebar, places by ⌘ key', async ({ page }) => {
  await page.getByRole('button', { name: 'Search', exact: true }).first().click();
  await expect(page.locator('header').first()).toContainText('Search');
  await sidebar(page).getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(page.locator('header').first()).toContainText('Usage');
  await page.keyboard.press('Meta+Digit2');
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
  await page.keyboard.press('Meta+Digit1');
  await expect(page.locator('header').first()).toContainText('Overview');
});
