import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Settings search (BLG-740): the field above the panes has focus when Settings opens; typing lists
 * the settings that match, grouped by pane, the others dimmed; ↑/↓ and Return (or a click) open
 * one: its pane shows, scrolled to the row, lit for a moment and focused. ⌘F comes back to the
 * field, Esc clears it, and a second Esc closes Settings.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

async function openSettings(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const dialog = settings(page);
  const field = dialog.getByRole('combobox', { name: 'Search settings' });
  await expect(field).toBeFocused();
  return { dialog, field };
}

test('Typing finds a setting, and Return opens its pane at the row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  const { dialog, field } = await openSettings(page);

  await page.keyboard.type('text size');
  const list = dialog.getByRole('listbox', { name: 'Settings found' });
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  const first = list.getByRole('option').first();
  await expect(first).toHaveAccessibleName('Appearance › Text size');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect(field).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
  await expect(list.getByRole('group', { name: 'Appearance' })).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveText(/settings? found/);
  await expect(dialog.getByRole('heading', { name: 'Search' })).toBeVisible();
  // A pane with nothing that matches is dimmed, one with a match isn't.
  const opacity = (name: string) => dialog.getByRole('button', { name, exact: true }).evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(await opacity('Voice'))).toBeLessThan(1);
  expect(Number(await opacity('Appearance'))).toBe(1);
  await page.screenshot({ path: `${SHOTS}/settings-search-results.png` });

  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Appearance', level: 2 })).toBeVisible();
  const row = dialog.locator('[data-setting="text-size"]');
  await expect(row).toBeInViewport();
  await expect(row).toHaveAttribute('data-found', '');
  // Focus is on its control, ready to change it.
  await expect(row.getByRole('slider')).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/settings-search-landed.png` });
  await expect(row).not.toHaveAttribute('data-found', '', { timeout: 4000 });
  // The words stay in the field.
  await expect(field).toHaveValue('text size');
});

test('↑/↓ move through the results, a row lower in its pane scrolls into view', async ({ page }) => {
  const { dialog, field } = await openSettings(page);
  await field.fill('scratch');
  const options = dialog.getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(1)).toHaveAccessibleName('Agent › Show the Scratch tab');
  await page.keyboard.press('ArrowDown');
  // Past the last, back to the first; and up again.
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');

  await expect(dialog.getByRole('heading', { name: 'Agent', level: 2 })).toBeVisible();
  const row = dialog.locator('[data-setting="show-the-scratch-tab"]');
  await expect(row).toBeInViewport();
  await expect(row.getByRole('switch', { name: 'Scratch tab' })).toBeFocused();
});

test('A click opens a result; a group with no row of that name opens at the group', async ({ page }) => {
  const { dialog, field } = await openSettings(page);
  await field.fill('tunnel');
  await dialog.getByRole('option', { name: 'People & access › How friends reach you' }).click();
  await expect(dialog.getByRole('heading', { name: 'People & access', level: 2 })).toBeVisible();
  await expect(dialog.locator('[data-setting="how-friends-reach-you"]')).toBeInViewport();

  await field.fill('launch flags');
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Agent', level: 2 })).toBeVisible();
  const group = dialog.locator('[data-setting-group="launch-flags"]');
  await expect(group).toBeInViewport();
  await expect(group).toBeFocused();
});

test('Nothing matching says so; ⌘F comes back to the field, Esc clears it, a second Esc closes', async ({ page }) => {
  const { dialog, field } = await openSettings(page);
  await page.keyboard.type('zzqx');
  await expect(dialog.getByText('No settings match “zzqx”', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveText('No settings match “zzqx”');
  await expect(field).toHaveAttribute('aria-expanded', 'true');

  // A pane picked in the sidebar shows, the words kept.
  await dialog.getByRole('button', { name: 'Voice', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Voice', level: 2 })).toBeVisible();
  await expect(field).not.toBeFocused();
  await page.keyboard.press('Meta+f');
  await expect(field).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
