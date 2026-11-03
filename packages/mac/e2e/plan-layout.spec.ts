import { expect, test, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/** A plan's page is two parts, the plan and its chat (KLD-54): no right panel, a chat toggle in the header (⌥⌘0), a chat as wide as you leave it, and no modes in the plan's own conversation. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');
const chat = (page: Page) => page.getByRole('complementary', { name: 'Conversation' });

async function openPlan(page: Page, name: RegExp): Promise<void> {
  await openWork(page, 'Plans');
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await main(page).getByRole('button', { name }).click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toBeVisible();
}

test('the plan and its chat share the page: no panel, a toggle that stays, a width that stays', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.goto('/');
  await openPlan(page, /^Card checkout for launch,/);
  // No right panel beside a plan, and no button for it.
  const panel = page.locator('aside[aria-label="Panel"]');
  await expect(panel).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('button', { name: /^(Show|Hide) the panel/ })).toHaveCount(0);
  await page.keyboard.press('Alt+Meta+Digit0');
  await expect(panel).toHaveAttribute('aria-hidden', 'true');
  // …⌥⌘0 hid the chat instead (its right side); the header's toggle is still there to bring it back.
  await expect(chat(page)).toHaveCount(0);
  const toggle = main(page).getByRole('button', { name: 'Show the Chat' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(chat(page)).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Hide the Chat' })).toHaveAttribute('aria-pressed', 'true');

  // 380 wide, wider from the keyboard on its edge, and kept.
  // (Within a pixel: the page's width splits into fractions.)
  expect(Math.abs((await chat(page).boundingBox())!.width - 380)).toBeLessThanOrEqual(1);
  const edge = page.getByRole('separator', { name: 'Resize the chat' });
  await edge.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => Math.abs((await chat(page).boundingBox())!.width - 428)).toBeLessThanOrEqual(1);

  // Hidden, then back after a reload: still hidden, and as wide when shown again.
  await main(page).getByRole('button', { name: 'Hide the Chat' }).click();
  await page.reload();
  await openPlan(page, /^Card checkout for launch,/);
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Card checkout for launch');
  await expect(chat(page)).toHaveCount(0);
  await main(page).getByRole('button', { name: 'Show the Chat' }).click();
  expect(Math.abs((await chat(page).boundingBox())!.width - 428)).toBeLessThanOrEqual(1);
  // Elsewhere (the group chat), the panel is as you left it.
  await sidebar(page).getByRole('button', { name: /^Group chat/ }).click();
  await expect(page.getByRole('button', { name: /^(Show|Hide) the panel/ })).toBeEnabled();
});

test('the plan’s own conversation has no Act / Plan / Tasks picker', async ({ page }) => {
  await page.goto('/');
  await openPlan(page, /^Card checkout for launch,/);
  await chat(page).getByRole('button', { name: 'Open the Whole Conversation' }).click();
  const chip = page.getByRole('button', { name: /^Mode: / });
  await expect(chip).toHaveText(/Plan/);
  await chip.click();
  await expect(page.getByRole('menuitem', { name: /^Act/ })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: /^Plan first/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Open the Plan' }).click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Card checkout for launch');
});
