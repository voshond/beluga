import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * A project's open pull requests on its home (BLG-602): anyone's, from the demo's pretend GitHub
 * (acme/bob-api), not only the ones your worktrees opened. One on a worktree's branch opens that
 * worktree.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');
/** Screenshots for the task's proof (BELUGA_SHOTS: a folder), skipped otherwise. */
const shot = async (page: Page, name: string): Promise<void> => {
  if (process.env.BELUGA_SHOTS) await page.screenshot({ path: path.join(process.env.BELUGA_SHOTS, name) });
};

async function openHome(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
}

test('a project’s home lists its open pull requests, and one on a worktree’s branch opens it', async ({ page }) => {
  await openHome(page);
  const section = main(page).getByRole('region', { name: 'Pull Requests' });
  await expect(section).toBeVisible();
  await expect(section.getByRole('heading', { name: /Pull Requests\s*5/ })).toBeVisible();
  const rows = section.locator('[data-pull]');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('Retry webhooks with backoff');
  // Someone else's, with its author, branch, review and checks.
  const teammate = section.locator('[data-pull="51"]');
  await expect(teammate).toContainText('sam-r');
  await expect(teammate).toContainText('fix/plus-in-email');
  // Review and checks are a mark each (their words on hover), not pills.
  await expect(teammate.getByRole('img', { name: 'Approved' })).toBeVisible();
  await expect(teammate.getByRole('img', { name: 'Checks pass' })).toBeVisible();
  await expect(section.locator('[data-pull="49"]')).toContainText('Draft');
  await expect(section.getByRole('button', { name: 'See all on GitHub' })).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shot(page, '01-home-pull-requests.png');
  // #52 is on the webhook-retries worktree's branch: a click opens that worktree.
  await rows.first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeHidden();
  await expect(page.getByText('webhook-retries').first()).toBeVisible();
});

test('See All opens every open pull request in Beluga, under Work', async ({ page }) => {
  await openHome(page);
  const section = main(page).getByRole('region', { name: 'Pull Requests' });
  await expect(section.getByRole('button', { name: 'See all on GitHub' })).toBeVisible();
  await section.getByRole('button', { name: 'See all pull requests' }).click();
  const list = main(page).getByRole('list', { name: 'bob-api’s open pull requests' });
  // All five, not Project Home's four.
  await expect(list.locator('[data-pull]')).toHaveCount(5);
  await expect(list.locator('[data-pull="51"]')).toContainText('sam-r');
  await expect(main(page).getByRole('tablist', { name: 'Work' }).getByRole('tab', { name: 'Pull Requests' })).toHaveAttribute('aria-selected', 'true');
  await expect(main(page).getByText(/5 open · acme\/bob-api · from GitHub/)).toBeVisible();
  await shot(page, '04-all-pull-requests.png');
  // The same rows: #52 is on a worktree's branch, a click opens it.
  await list.locator('[data-pull="52"]').click();
  await expect(page.getByText('webhook-retries').first()).toBeVisible();
});

test('Open in Worktree checks a teammate’s pull request out in a new worktree, and opens it', async ({ page }) => {
  await openHome(page);
  const section = main(page).getByRole('region', { name: 'Pull Requests' });
  const teammate = section.locator('[data-pull="51"]');
  // The one already in a worktree has no button: a click opens it.
  await expect(section.locator('[data-pull="52"]').getByRole('button', { name: /in a worktree/ })).toHaveCount(0);
  await teammate.scrollIntoViewIfNeeded();
  await teammate.hover();
  const button = teammate.getByRole('button', { name: 'Open #51 in a worktree' });
  await expect(button).toBeVisible();
  // It takes the marks' place on the row: its words fit, nothing squeezed.
  expect(await button.evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true);
  await expect(teammate).toContainText('Open in Worktree');
  // Its fade-in done, for the screenshot.
  await page.waitForTimeout(200);
  await shot(page, '02-open-in-worktree.png');
  await button.click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeHidden();
  await expect(page.getByText(/Pull request #51 “Decode emails safely in the user lookup”, checked out on fix\/plus-in-email/)).toBeVisible({ timeout: 15_000 });
  await shot(page, '03-pull-request-worktree.png');
  // Back home, its row now opens that worktree.
  await openHome(page);
  await expect(main(page).getByRole('region', { name: 'Pull Requests' }).locator('[data-pull="51"]')).toHaveAttribute('aria-label', /in a worktree/);
});
