import { expect, test, type Page } from './fixtures.js';
import { openPlansList } from './helpers.js';

/**
 * Acceptance criteria that count (KLD-74): one not ticked yet carries its reason ("— deferred: why",
 * "— not done: why") and shows as its own state on the task page, the worktree's strip and the plan's details.
 * The demo's "Add auth to the payment routes" has one of each.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

test.describe.configure({ mode: 'serial' });

/** bob-api's demo plan, as a list: its task worktrees stay off the sidebar, so their tasks are reached from here. */
async function openPlan(page: Page): Promise<void> {
  await page.goto('/');
  await openPlansList(page);
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
}

test('the strip and the task page show deferred and not-done criteria with their reasons', async ({ page }) => {
  // The task works in the plan's checkout-auth worktree: its strip is there.
  await openPlan(page);
  await main(page).getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: 'List' }).click();
  await page.getByRole('region', { name: 'Safe payments' }).getByText('Add auth to the payment routes', { exact: true }).first().click();
  await page.getByRole('complementary', { name: 'Details' }).getByRole('button', { name: /Open Worktree/ }).click();
  await expect(page.locator('main header').first()).toContainText('checkout-auth');
  const strip = page.getByRole('button', { name: /Add auth to the payment routes/ }).first();
  await expect(strip).toContainText('2/4 · 1 deferred · 1 not done');
  await strip.click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Add auth to the payment routes');
  const criteria = page.getByRole('region', { name: 'Acceptance criteria' });
  await expect(criteria).toContainText('2 of 4 · 1 deferred · 1 not done');
  const deferred = criteria.locator('li[data-state="deferred"]');
  await expect(deferred).toContainText('Tests for missing, expired and valid sessions');
  await expect(deferred).toContainText('Deferred · the expired one comes with that fix');
  await expect(deferred.getByRole('checkbox', { name: /^Deferred/ })).not.toBeChecked();
  await expect(criteria.locator('li[data-state="not_done"]')).toContainText('Not done · next turn, see the handoff');
  // Explained, so it isn't held out of review.
  await expect(page.getByText('Needs its checks')).toHaveCount(0);
});

test('the plan’s task details show the same states', async ({ page }) => {
  await openPlan(page);
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  await main(page).locator('.react-flow__node').filter({ hasText: 'Add auth to the payment routes' }).click();
  const done = page.getByRole('complementary', { name: 'Details' }).getByRole('region', { name: 'Done when' });
  await expect(done.locator('li[data-state="done"]')).toHaveCount(2);
  await expect(done.locator('li[data-state="deferred"]')).toContainText('Deferred · the expired one comes with that fix');
  await expect(done.locator('li[data-state="not_done"]')).toContainText('Not done · next turn, see the handoff');
});
