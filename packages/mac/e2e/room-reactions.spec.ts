import { expect, test, type Page } from './fixtures.js';

/**
 * Emoji reactions in the room's group chat (BLG-702), against the demo: bob likes mia's line from
 * his own (pretend) Mac, and yours go to everyone in the room. SHOTS=<folder>: screenshots there.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

test('the group chat: a friend’s reaction shows, yours goes on from the hover button and comes off from its chip', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'Group chat' }).first().click();
  const mias = page.locator('[data-chat]').filter({ hasText: 'hi all, joining from the landing page side' }).first();
  await expect(mias).toBeVisible({ timeout: 20_000 });
  // bob likes it from his Mac, through the room.
  await expect(mias.getByRole('button', { name: /^👍 1: bob reacted with 👍/ })).toBeVisible({ timeout: 20_000 });

  await mias.hover();
  await mias.getByRole('button', { name: 'Add Reaction' }).click();
  const row = page.getByRole('group', { name: 'React' });
  await expect(row.getByRole('button', { name: /^React with / })).toHaveCount(6);
  await row.getByRole('button', { name: 'React with 👍' }).click();
  const thumbs = mias.getByRole('button', { name: /^👍 2: / });
  await expect(thumbs).toHaveAttribute('aria-pressed', 'true');
  await expect(thumbs).toHaveAccessibleName(/you/);

  await mias.hover();
  await mias.getByRole('button', { name: 'Add Reaction' }).click();
  await page.getByRole('button', { name: 'More emoji' }).click();
  await page.getByRole('textbox', { name: 'Search emoji' }).fill('sparkles');
  await page.getByRole('button', { name: 'sparkles', exact: true }).click();
  await expect(mias.getByRole('button', { name: /^✨ 1: you reacted/ })).toBeVisible();
  await page.mouse.move(0, 0);
  await shot(page, 'room-reactions');

  // Yours off again; bob's stays.
  await thumbs.click();
  await expect(mias.getByRole('button', { name: /^👍 1: bob reacted/ })).toHaveAttribute('aria-pressed', 'false');
  await mias.getByRole('button', { name: /^✨/ }).click();
  await expect(mias.getByRole('button', { name: /^✨/ })).toHaveCount(0);
});
