import { expect, test, type Page } from './fixtures.js';

/** Remind Me Later on a worktree with the sidebar categories off, from its right-click menu (BLG-748, BLG-770): folded under Later until then, or Show Again Now. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });

async function worktreeRow(page: Page, name: string) {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await expect(row).toBeVisible();
  return row;
}

test('put a worktree off for an hour, then show it again', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const row = await worktreeRow(page, 'add-auth');
  // The project's page is in (it takes focus as it comes, which would close a menu).
  await expect(page.getByText('What do you want to do in bob-api?')).toBeVisible();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remind Me Later' }).hover();
  const hour = page.getByRole('menuitem', { name: /^In 1 Hour/ });
  await expect(hour).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Next Week/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Custom/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('remind-menu.png') });
  await hour.click();
  // Out of the way: folded under Later at the bottom of the project.
  const later = sidebar(page).getByRole('button', { name: 'Later, 1' });
  await expect(later).toBeVisible();
  await expect(later).toHaveAttribute('aria-expanded', 'false');
  await expect(row).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('later-folded.png') });
  // Unfolded: a quiet clock, and the tooltip says when it reminds you.
  await later.click();
  await expect(row.locator('[data-signal="later"]')).toBeVisible();
  await expect(row).toHaveAttribute('title', /Reminds you (tomorrow )?at \d\d:\d\d/);
  await page.screenshot({ path: test.info().outputPath('later-open.png') });
  // In it, the line above the message box says when.
  await row.click();
  await expect(page.getByRole('status', { name: 'Chat category' })).toContainText(/Reminds you (tomorrow )?at \d\d:\d\d/);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Show Again Now/ }).click();
  // Back in its place.
  await expect(later).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-signal="later"]')).toHaveCount(0);
});
