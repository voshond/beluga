import { expect, test, type Page } from './fixtures.js';

/**
 * A plan waiting for approval: what you type is what to change in it, so the box says so. It shows
 * "Plan Review" and one "Send Changes" button, never Steer or Queue (the turn waits on you, it isn't
 * working). The demo's Claude in Plan First proposes a plan and revises it from what you say (src/agent/mock.ts).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();
const shot = (name: string): string => `../../.beluga/scratch/${name}`;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('while a plan waits, the box sends changes to it, not a steer or a queue', async ({ page }) => {
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await composer(page).press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Mode: Plan First' })).toBeVisible();
  await composer(page).fill('Add login to the API');
  await composer(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Approve plan' })).toBeVisible({ timeout: 20_000 });

  await expect(page.getByRole('status').filter({ hasText: 'Plan Review' })).toContainText('changes to the plan');
  await expect(composer(page)).toHaveAttribute('placeholder', /what to change in the plan/);
  await composer(page).fill('Use signed cookies');
  await expect(page.getByRole('button', { name: 'Send Changes' })).toBeEnabled();
  await expect(page.getByRole('group', { name: /is working/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Steer|Queue)$/ })).toHaveCount(0);
  await expect(page.getByText('In Plan First, messages queue.')).toHaveCount(0);
  await page.locator('main').screenshot({ path: shot('plan-review-box.png') });

  // Read in full: the card grows up in place, from the plan's first line; no sheet on top of the chat.
  await page.getByRole('button', { name: 'Read in full' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const plan = page.getByRole('region', { name: 'The plan' });
  await expect(page.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => plan.evaluate((el) => getComputedStyle(el).maxHeight)).not.toBe('224px');
  expect(await plan.evaluate((el) => el.scrollTop)).toBe(0);
  await page.locator('main').screenshot({ path: shot('plan-read-in-full.png') });
  await page.getByRole('button', { name: 'Show less' }).click();
  await expect(page.getByRole('button', { name: 'Read in full' })).toHaveAttribute('aria-expanded', 'false');

  // Sent: Claude takes it as the plan's changes and the card goes.
  await page.getByRole('button', { name: 'Send Changes' }).click();
  await expect(page.getByText(/revise the plan: Use signed cookies/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Approve plan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send Changes' })).toHaveCount(0);
});
