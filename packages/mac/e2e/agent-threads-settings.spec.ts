import path from 'node:path';
import { expect, test } from './fixtures.js';

/**
 * Agent threads (BLG-171): the switch in Settings › Advanced and the 4 limits in Settings › Agent,
 * next to Open chats. Both save through session.setPrefs.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');

test('The switch and the limits are in Settings', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const search = dialog.getByRole('combobox', { name: 'Search settings' });

  // Off: no limits, in the pane or in the search.
  await search.fill('Levels of threads');
  await expect(dialog.getByRole('option', { name: /Levels of threads/ })).toHaveCount(0);
  await search.fill('');
  await dialog.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(dialog.getByText('Open chats', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Thread limits', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, 'agent-threads-off-no-limits.png') });

  await search.fill('Let your agents start threads');
  await page.keyboard.press('Enter');
  const on = dialog.getByRole('switch', { name: 'Agent threads' });
  await expect(on).toHaveAttribute('aria-checked', 'false');
  await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: path.join(SHOTS, 'agent-threads-switch.png') });

  await search.fill('Levels of threads');
  await page.keyboard.press('Enter');
  await expect(dialog.getByText('Thread limits', { exact: true })).toBeVisible();
  for (const row of ['Levels of threads', 'Working at once in one chat’s tree', 'Kept in one chat’s tree', 'Working at once on this computer']) await expect(dialog.getByText(row, { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'agent-threads-limits.png') });
});
