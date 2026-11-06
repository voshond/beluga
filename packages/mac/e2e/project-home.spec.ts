import { expect, test, type Page } from './fixtures.js';

/**
 * Never change main: clicking a project opens its home, work starts in a new worktree, and a
 * chat in the main folder is questions only (asking for a change there moves to a worktree).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const home = (page: Page) => page.getByRole('main');

async function openHome(page: Page, project = 'bob-api'): Promise<void> {
  // The label itself (the row also holds the hover buttons).
  await sidebar(page).getByText(project, { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: project })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('clicking a project opens its home', async ({ page }) => {
  await openHome(page);
  await expect(page.getByRole('heading', { name: 'What do you want to do in bob-api?' })).toBeVisible();
  await expect(page.getByText('Up to date with origin/main')).toBeVisible();
  const worktrees = page.getByRole('region', { name: 'Worktrees' });
  await expect(worktrees.getByRole('button', { name: /add-auth/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Questions' }).getByRole('button', { name: /How do deploys work/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'New Worktree' })).toHaveAttribute('aria-selected', 'true');
});

test('the home box has a microphone beside Create Worktree', async ({ page }) => {
  await openHome(page);
  const section = page.getByRole('region', { name: 'Start something' });
  const mic = section.getByRole('button', { name: 'Speak instead of typing' });
  await expect(mic).toBeVisible();
  await mic.hover();
  await expect(page.getByText(/hold ⌥Space to talk/)).toBeVisible();
  if (process.env.BELUGA_SHOTS) await section.screenshot({ path: `${process.env.BELUGA_SHOTS}/home-composer-mic.png` });
});

test('New Worktree from the home makes a worktree and starts Claude there', async ({ page }) => {
  await openHome(page);
  await page.getByLabel('Task for the new worktree').fill('Add request logging');
  await page.getByLabel('Task for the new worktree').press('Enter');
  // The worktree opens on its conversation (the center no longer has Chat/Files/Diff/Terminal tabs).
  await expect(page.locator('textarea:not(.xterm-helper-textarea)')).toHaveAttribute('placeholder', /Tell Claude what to do in/, { timeout: 15_000 });
  await expect(home(page).getByText('Add request logging').first()).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: /add-request-logging/ }).first()).toBeVisible();
  // A worktree, not main: no questions-only banner.
  await expect(page.getByRole('note', { name: 'Questions only' })).toHaveCount(0);
});

test('Just Ask starts a questions-only chat in main, with the banner', async ({ page }) => {
  await openHome(page);
  await page.getByRole('tab', { name: 'Just Ask' }).click();
  await page.getByLabel('Question about bob-api').fill('Where are the routes defined?');
  await page.getByLabel('Question about bob-api').press('Enter');
  const banner = page.getByRole('note', { name: 'Questions only' });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText('your agent won’t change anything in main');
  await expect(page.locator('textarea[placeholder="Ask about bob-api…"]')).toBeVisible();
  await expect(home(page).getByText('Where are the routes defined?').first()).toBeVisible();
});

test('Continue in New Worktree carries the conversation to a new worktree', async ({ page }) => {
  await openHome(page);
  await page.getByRole('tab', { name: 'Just Ask' }).click();
  await page.getByLabel('Question about bob-api').fill('Explain the billing flow');
  await page.getByLabel('Question about bob-api').press('Enter');
  await expect(page.getByRole('note', { name: 'Questions only' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-turn="done"]').last()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('note', { name: 'Questions only' }).getByRole('button', { name: 'Continue in New Worktree…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Continue in a New Worktree' });
  await expect(sheet.getByLabel('Task')).toHaveValue('Explain the billing flow');
  await sheet.getByLabel('Task').fill('Add idempotency keys to billing');
  await sheet.getByRole('button', { name: 'Continue' }).click();
  // Now in the worktree: the conversation came along, Claude works on the task.
  await expect(page.getByRole('note', { name: 'Questions only' })).toHaveCount(0, { timeout: 15_000 });
  await expect(home(page).getByText('Explain the billing flow').first()).toBeVisible();
  await expect(home(page).getByText(/This chat is now the worktree/)).toBeVisible();
  await expect(home(page).getByText('Add idempotency keys to billing').first()).toBeVisible();
});

test('asking for a change in a questions-only chat moves to a new worktree on its own', async ({ page }) => {
  await openHome(page);
  await page.getByRole('tab', { name: 'Just Ask' }).click();
  await page.getByLabel('Question about bob-api').fill('Fix the typo in the README');
  await page.getByLabel('Question about bob-api').press('Enter');
  await expect(page.getByRole('note', { name: 'Questions only' })).toHaveCount(0, { timeout: 20_000 });
  await expect(home(page).getByText(/This chat is now the worktree/)).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: /fix-typo-readme/ }).first()).toBeVisible();
});

test('clicking a folded project unfolds it until you go elsewhere; opening one of its items keeps it open', async ({ page }) => {
  const project = sidebar(page).getByRole('button', { name: 'landing', exact: true }).and(page.locator('[aria-expanded]'));
  const row = (name: string) => sidebar(page).getByRole('button', { name, exact: true });
  // Start folded.
  if ((await project.getAttribute('aria-expanded')) === 'true') await sidebar(page).getByRole('button', { name: 'Fold landing' }).click();
  await expect(project).toHaveAttribute('aria-expanded', 'false');

  // One click on the row: its home, unfolded.
  await openHome(page, 'landing');
  await expect(project).toHaveAttribute('aria-expanded', 'true');
  await expect(row('new-hero')).toBeVisible();
  // Somewhere else: it folds again, so the sidebar stays tidy.
  await openHome(page, 'bob-api');
  await expect(project).toHaveAttribute('aria-expanded', 'false');
  await expect(row('new-hero')).toBeHidden();

  // Open it, then one of its items: it stays open after you leave.
  await openHome(page, 'landing');
  await row('new-hero').click();
  await openHome(page, 'bob-api');
  await expect(project).toHaveAttribute('aria-expanded', 'true');
  await expect(row('new-hero')).toBeVisible();
});

test('the home lists the project’s plans, each opening its page', async ({ page }) => {
  await openHome(page);
  const plans = page.getByRole('region', { name: 'Plans' });
  await plans.getByRole('button', { name: /^Card checkout for launch:/ }).click();
  await expect(page.getByRole('textbox', { name: 'Plan name' })).toHaveValue('Card checkout for launch');
});

test('New Plan from the home: with no goal the sheet opens in this project; with one, Claude starts planning', async ({ page }) => {
  await openHome(page);
  await page.getByRole('tab', { name: 'New Plan' }).click();
  const goal = page.getByLabel('Goal for a plan in bob-api');
  const start = page.getByRole('button', { name: /^Plan with Claude/ });
  // Nothing typed: the New Plan sheet, already in bob-api (no project picker).
  await start.click();
  const sheet = page.getByRole('dialog', { name: 'Plan in bob-api' });
  await expect(sheet.getByRole('combobox', { name: 'Project' })).toHaveCount(0);
  await expect(sheet.getByLabel('Goal')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  // A goal and a mode beside the button: the plan's page opens and Claude drafts it.
  const runs = page.getByRole('combobox', { name: 'How it runs' });
  await expect(runs).toContainText('Check-ins');
  await runs.click();
  await page.getByRole('option', { name: /Step by Step/ }).click();
  await expect(runs).toContainText('Step by Step');
  await goal.fill('Export orders as CSV for the accountants');
  await goal.press('Enter');
  await expect(page.getByRole('button', { name: 'Approve Plan' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('a draft, not on the board yet')).toBeVisible();
  await expect(home(page).locator('.react-flow__node').filter({ hasText: 'Data model and migration' })).toBeVisible({ timeout: 20_000 });
  // Back home, it's in the project's plans.
  await openHome(page);
  await expect(page.getByRole('region', { name: 'Plans' }).getByRole('button', { name: /^Export orders accountants/ })).toBeVisible();
});

test('the home shows the latest few tasks and GitHub issues, each opening, with the way to all of them (BLG-625)', async ({ page }) => {
  await openHome(page);
  const tasks = page.getByRole('region', { name: 'Tasks' });
  // The demo's board has more open tasks, and its pretend GitHub more open issues: three of each.
  await expect(tasks.getByRole('listitem')).toHaveCount(3);
  const issues = page.getByRole('region', { name: 'Issues' });
  await expect(issues.getByRole('listitem')).toHaveCount(3, { timeout: 15_000 });
  if (process.env.BELUGA_SHOTS) {
    await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('[aria-label="Tasks"]')?.scrollIntoView({ block: 'start' }));
    await page.getByRole('main').screenshot({ path: `${process.env.BELUGA_SHOTS}/home-tasks-issues.png` });
  }
  // A row opens its task; Show All Tasks opens the board on this project.
  const first = tasks.getByRole('button').filter({ hasNotText: 'Show All Tasks' }).first();
  const title = (await first.getAttribute('aria-label'))!.replace(/^[A-Z]+-\d+: /, '').replace(/, [^,]+$/, '');
  await first.click();
  await expect(page.getByRole('main').getByText(title).first()).toBeVisible();
  await openHome(page);
  await page.getByRole('region', { name: 'Tasks' }).getByRole('button', { name: 'Show All Tasks' }).click();
  await expect(page.getByRole('tablist', { name: 'Show' })).toBeVisible();
});
