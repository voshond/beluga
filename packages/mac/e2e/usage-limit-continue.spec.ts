import { expect, test, type Page } from './fixtures.js';

/**
 * A run that stopped on your usage limit (BLG-757): the card says when Beluga tells the agent to
 * continue, and Don't Send turns it off for this chat (Continue and Send at… then). The demo's
 * Claude stops this way when told "usage limit" (src/agent/mock.ts).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)').first();
const SHOTS = process.env.BELUGA_SHOTS;

test('the limit card says when it continues, and Don’t Send turns it off for this chat', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /new-hero/);

  await composer(page).fill('usage limit');
  await composer(page).press('Enter');
  await expect(page.getByText(/You hit your Claude plan usage limit/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Sends “Continue where you left off\.” at .*, when your limit resets/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Don’t Send', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /For This Session/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Everywhere/ })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/usage-limit-scheduled.png` });
  await menu.getByRole('menuitem', { name: /Never in This Chat/ }).click();

  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  const undo = page.getByRole('button', { name: /^Send at / });
  await expect(undo).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/usage-limit-off-here.png` });
  await undo.click();
  await expect(page.getByText(/Sends “Continue where you left off\.” at/)).toBeVisible();
});
