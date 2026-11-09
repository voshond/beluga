import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Settings › Your Computers (BLG-780), on the demo's two computers (BLG-779): where new work runs,
 * one main action to add a computer, and each computer with its icon, name, kind, status, load and
 * health, with the fix for what isn't ready.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../.beluga/scratch');
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

test('Your Computers lists the demo’s Mac mini and build-box, with Run New Work On and Add a Computer', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const pane = settings(page);
  await pane.getByRole('button', { name: 'Your Computers', exact: true }).click();

  await expect(pane.getByText('Run New Work On', { exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Add a Computer…' })).toBeVisible();
  const mini = pane.locator('[data-machine="de30a1c0ffee0001"]');
  const aws = pane.locator('[data-machine="de30a1c0ffee0002"]');
  await expect(mini.getByText('Mac mini at home')).toBeVisible();
  await expect(mini.getByText('Mac mini', { exact: true })).toBeVisible();
  await expect(aws.getByText('AWS · eu-west-1')).toBeVisible();
  await expect(aws.getByText(/% busy · .* GB free/)).toBeVisible();
  // Codex isn't signed in on the build-box: its fix, with the command to copy.
  await expect(aws.getByText('Sign Codex in on build-box')).toBeVisible();
  await expect(aws.getByText('codex login')).toBeVisible();
  await pane.screenshot({ path: path.join(SHOTS, 'blg-780-your-computers.png') });

  // Add a Computer: over SSH or with a link or code.
  await pane.getByRole('button', { name: 'Add a Computer…' }).click();
  await expect(pane.getByRole('radio', { name: 'Over SSH' })).toHaveAttribute('aria-checked', 'true');
  await expect(pane.getByRole('radio', { name: 'Link or Code' })).toBeVisible();
  await expect(pane.getByRole('textbox', { name: 'user@host' })).toBeVisible();
  await pane.screenshot({ path: path.join(SHOTS, 'blg-780-add-a-computer.png') });
});

/**
 * A computer's page (BLG-784): the build-box's webhook-retries opens from Your Computers and draws
 * with that computer's client (the demo daemon serves its demo computers' screens itself), tagged
 * with the computer. The same worktree on this Mac is another page: Back and Forward go between the
 * two, and each keeps its own unsent words.
 */
test('a computer’s worktree opens in the pane, tagged, and keeps its own state beside this Mac’s', async ({ page }) => {
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const composer = page.locator('textarea:not(.xterm-helper-textarea)');
  const tag = page.getByTitle('Runs on build-box');
  await page.goto('/');
  await expect(sidebar).toBeVisible();
  // This Mac's webhook-retries first, with words left in its box.
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  if (!(await sidebar.getByRole('button', { name: 'webhook-retries', exact: true }).isVisible())) await sidebar.getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar.getByRole('button', { name: 'webhook-retries', exact: true }).click();
  await expect(composer).toHaveAttribute('placeholder', /webhook-retries/);
  await composer.fill('words for this Mac');
  await expect(tag).toHaveCount(0);

  // The build-box's, from Your Computers.
  await page.keyboard.press('Meta+,');
  const pane = settings(page);
  await pane.getByRole('button', { name: 'Your Computers', exact: true }).click();
  await pane.getByRole('button', { name: 'Open webhook-retries on build-box' }).click();
  await expect(pane).toBeHidden();
  await expect(tag).toBeVisible();
  await expect(composer).toHaveAttribute('placeholder', /webhook-retries/);
  // Its own box: this Mac's words stay with this Mac's page.
  await expect(composer).toHaveValue('');
  await composer.fill('words for the build-box');
  await page.screenshot({ path: path.join(SHOTS, 'blg-784-computer-pane.png') });

  // Back: this Mac's page, as it was.
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(tag).toHaveCount(0);
  await expect(composer).toHaveValue('words for this Mac');
  // Forward: the build-box's again, as it was.
  await page.getByRole('button', { name: 'Go forward', exact: true }).click();
  await expect(tag).toBeVisible();
  await expect(composer).toHaveValue('words for the build-box');
});

/**
 * Runs on (BLG-786): with the demo's computers paired, the project home's box says where new work
 * runs, its menu lists This Mac, each computer with its line and Best Available, the pick is kept
 * for the project, and an existing chat says where it runs as a label.
 */
test('Runs on picks where new work goes, remembers it for the project, and labels a chat', async ({ page }) => {
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const openHome = async (): Promise<void> => {
    await sidebar.getByText('bob-api', { exact: true }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
  };
  await page.goto('/');
  await expect(sidebar).toBeVisible();
  await openHome();
  const chip = page.getByRole('button', { name: 'Runs on This Mac' });
  await expect(chip).toBeVisible();
  await chip.click();
  const menu = page.getByRole('menu', { name: 'Runs on' });
  await expect(menu.getByRole('menuitem', { name: /^This Mac: The computer in front of you/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Mac mini at home: Mac mini · \d+ GB free/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^build-box: AWS · \d+ GB free · 1 task running/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^Best Available: Picks the computer with the most room\./ })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'blg-786-runs-on-menu.png') });
  await menu.getByRole('menuitem', { name: /^build-box/ }).click();
  await expect(page.getByRole('button', { name: 'Runs on build-box' })).toBeVisible();

  // Kept for the project.
  await page.reload();
  await expect(sidebar).toBeVisible();
  await openHome();
  await expect(page.getByRole('button', { name: 'Runs on build-box' })).toBeVisible();

  // An existing chat: where it runs, as a label; MCP is in the box, on its right beside the context.
  if (!(await sidebar.getByRole('button', { name: 'add-auth', exact: true }).isVisible())) await sidebar.getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar.getByRole('button', { name: 'add-auth', exact: true }).click();
  await expect(page.getByLabel('Runs on This Mac')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Runs on This Mac' })).toHaveCount(0);
  const field = await page.locator('textarea:not(.xterm-helper-textarea)').boundingBox();
  const mcp = await page.getByRole('button', { name: /^MCP servers: / }).boundingBox();
  expect(mcp!.y).toBeGreaterThan(field!.y);
  expect(mcp!.x).toBeGreaterThan(field!.x + field!.width / 2);
  await page.screenshot({ path: path.join(SHOTS, 'blg-786-runs-on-label.png') });
});

/**
 * Every computer in one sidebar (BLG-785): the build-box's webhook-retries lists under bob-api
 * with the computer's mark and short name, the sidebar's search finds it there too, and it opens in
 * the pane with that computer's client.
 */
test('a computer’s worktree lists under its project, tagged, and search finds it', async ({ page }) => {
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await page.goto('/');
  await expect(sidebar).toBeVisible();
  const remote = sidebar.getByRole('button', { name: 'webhook-retries on build-box' });
  if (!(await remote.isVisible())) await sidebar.getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await expect(remote).toBeVisible();
  // The row shows the computer's mark (AWS's), with its name on hover.
  await expect(remote.getByTitle('On build-box')).toBeVisible();
  await expect(remote.getByRole('img', { name: 'AWS' })).toBeVisible();
  // This Mac's own webhook-retries is still its own row.
  await expect(sidebar.getByRole('button', { name: 'webhook-retries', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'blg-785-sidebar.png') });

  await sidebar.getByRole('textbox', { name: 'Search chats and messages' }).fill('webhook');
  const results = page.getByRole('listbox', { name: 'Search results' });
  await expect(results.getByRole('option').filter({ hasText: 'bob-api · build-box' })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'blg-785-search.png') });
  await results.getByRole('option').filter({ hasText: 'bob-api · build-box' }).click();
  await expect(page.getByTitle('Runs on build-box')).toBeVisible();
});

/**
 * Start the work on that computer (BLG-788): with Runs on set to the build-box, Create Worktree in
 * bob-api's home makes the worktree there, in the same project, and opens it at once in the pane,
 * tagged with the computer, listed under bob-api with its tag.
 */
test('a worktree started with Runs on a computer is made there and opens tagged', async ({ page }) => {
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await page.goto('/');
  await expect(sidebar).toBeVisible();
  await sidebar.getByText('bob-api', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
  await page.getByRole('button', { name: /^Runs on / }).click();
  await page.getByRole('menu', { name: 'Runs on' }).getByRole('menuitem', { name: /^build-box/ }).click();
  await expect(page.getByRole('button', { name: 'Runs on build-box' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Worktree name' }).fill('health-check');
  await page.locator('textarea:not(.xterm-helper-textarea)').first().fill('Add a health check endpoint');
  await page.getByRole('button', { name: /Create Worktree/ }).first().click();
  // Opened at once in the pane, with the computer's tag.
  await expect(page.getByTitle('Runs on build-box')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('main').getByText('health-check').first()).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'health-check on build-box' })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(SHOTS, 'blg-788-started-there.png') });
});

/**
 * A chat outside a project runs where Runs on says (BLG-841): picked, or from Run New Work On with
 * no pick, it starts on that computer, in its own chats, and opens tagged in the pane; never on this Mac.
 */
test('a chat outside a project starts on the picked computer, and on Run New Work On’s without a pick', async ({ page }) => {
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  const composer = page.locator('textarea:not(.xterm-helper-textarea)').first();
  const newChat = async (): Promise<void> => {
    await sidebar.getByRole('button', { name: 'New chat (not tied to a project)' }).click();
    await expect(page.getByRole('button', { name: /^Runs on / })).toBeVisible();
  };
  await page.goto('/');
  await expect(sidebar).toBeVisible();
  await newChat();
  await page.getByRole('button', { name: /^Runs on / }).click();
  await page.getByRole('menu', { name: 'Runs on' }).getByRole('menuitem', { name: /^build-box/ }).click();
  await expect(page.getByRole('button', { name: 'Runs on build-box' })).toBeVisible();
  await composer.fill('What is using the disk on this server?');
  await composer.press('Enter');
  await expect(page.getByTitle('Runs on build-box')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('main').getByText('What is using the disk on this server?').first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'blg-841-chat-on-aws.png') });

  // No pick for chats any more (back to This Mac), then Run New Work On says the Mac mini: it goes there.
  await newChat();
  await page.getByRole('button', { name: /^Runs on / }).click();
  await page.getByRole('menu', { name: 'Runs on' }).getByRole('menuitem', { name: /^This Mac/ }).click();
  await page.evaluate(() => localStorage.removeItem('beluga.runsOn.v1'));
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Your Computers', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Run New Work On' }).click();
  await page.getByRole('option', { name: 'Mac mini at home' }).click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await page.reload();
  await expect(sidebar).toBeVisible();
  await newChat();
  await expect(page.getByRole('button', { name: 'Runs on Mac mini at home' })).toBeVisible();
  await composer.fill('Which disks are mounted?');
  await composer.press('Enter');
  await expect(page.getByTitle('Runs on Mac mini at home')).toBeVisible({ timeout: 20_000 });

  // Back to This Mac for what comes after.
  await page.keyboard.press('Meta+,');
  await settings.getByRole('button', { name: 'Your Computers', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Run New Work On' }).click();
  await page.getByRole('option', { name: 'This Mac' }).click();
  await page.keyboard.press('Escape');
});
