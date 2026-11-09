import { expect, test, type Page } from './fixtures.js';

/** "@" in a worktree's chat keeps other projects' tasks last, apart, and asks before one goes in (BLG-397). */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

test('another project’s task is offered last, says so when picked, and goes in on the second pick', async ({ page }) => {
  await page.goto('/');
  // new-hero is the landing project's worktree; "Refund endpoint" is bob-api's task.
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name: 'new-hero', exact: true }).click();
  const box = page.locator('main textarea').last();
  const list = page.getByRole('listbox', { name: 'Suggestions' });

  // The first couple of letters: only this project's.
  await box.fill('see @re');
  await expect(list).not.toContainText('Refund endpoint');

  await box.fill('see @refund');
  await expect(list).toContainText('In other projects, not this one');
  const option = list.getByRole('option').last();
  await expect(option).toContainText('Refund endpoint');
  if (process.env.BELUGA_SHOTS) await list.screenshot({ path: `${process.env.BELUGA_SHOTS}/01-other-project-section.png` });

  // The first pick only says it isn't this project's.
  await option.click();
  await expect(option).toContainText('not this project');
  await expect(box).toHaveValue('see @refund');
  if (process.env.BELUGA_SHOTS) await list.screenshot({ path: `${process.env.BELUGA_SHOTS}/02-other-project-asking.png` });

  // The second puts it in.
  await option.click();
  await expect(box).toHaveValue(/^see @[A-Z]+-\d+ $/);
});
