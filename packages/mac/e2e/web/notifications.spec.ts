import { expect, test } from '@playwright/test';
import { type Served, startServed } from './served.js';

let web: Served;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  web = await startServed();
});
test.afterAll(async () => web?.stop());

test('notifications open under the bell, or as a page where the bell can’t be seen', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('beluga.onboarding.v1', JSON.stringify({ version: 'e2e', at: 0, how: 'finished' })));
  await page.goto(web.link);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const showAll = inspector.getByRole('button', { name: 'Show all' });
  const popover = page.getByRole('dialog', { name: 'Notifications' });
  const center = page.getByRole('region', { name: 'Notifications' });
  await expect(showAll).toBeVisible({ timeout: 30_000 });

  await showAll.click();
  await expect(popover).toBeVisible();
  await expect(center).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await showAll.click();
  await expect(center).toBeVisible();
  await expect(popover).toHaveCount(0);
  await expect(center.getByText('bob joined')).toBeVisible();

  await center.getByText('bob joined').click();
  await expect(center).toBeHidden();
  await expect(page.getByPlaceholder(/Message the room/)).toBeAttached();
});
