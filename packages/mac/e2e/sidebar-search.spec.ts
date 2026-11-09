import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * The search field at the top of the sidebar (BLG-67): chats at once, messages below them; Enter
 * opens the selected result, Esc clears the query and the sections come back as they were, ⌥⌘F
 * focuses it, and See All opens the Search page. Set SHOTS to a folder for the screenshots.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const field = (page: Page) => sidebar(page).getByRole('textbox', { name: 'Search chats and messages' });
const results = (page: Page) => sidebar(page).getByRole('listbox', { name: 'Search results' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const shot = async (page: Page, name: string): Promise<void> => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

async function openAddAuth(page: Page): Promise<void> {
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().waitFor();
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
}

test('a branch name finds its worktree: Enter arrives there', async ({ page }) => {
  await page.goto('/');
  await openAddAuth(page);
  // The branch, read from the demo itself: the row of a search for its name shows it.
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  await field(page).fill('add-auth');
  const first = results(page).getByRole('option').first();
  await expect(first).toContainText('add-auth');
  const detail = (await first.innerText()).split('\n')[1] ?? '';
  const branch = detail.split(' · ')[1];
  expect(branch, detail).toBeTruthy();

  await field(page).fill(branch!);
  await expect(results(page).getByRole('option').first()).toContainText('add-auth');
  await field(page).press('Enter');
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
});

test('a word in a message opens its chat at that message', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  await page.getByRole('button', { name: 'New chat with Your Mac' }).click();
  const tmp = path.join(process.env.BELUGA_HOME!, 'tmp');
  const dir = path.join(tmp, readdirSync(tmp).find((n) => n.startsWith('beluga-demo-assistant-'))!);
  let chat = '';
  await expect.poll(() => (chat = (JSON.parse(readFileSync(path.join(dir, 'chats.json'), 'utf8')) as { active: string }).active)).not.toBe('main');
  const channel = `mac:assistant:${chat}`;
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, type: 'chat', channel, from: 'me', name: 'kay', text: i === 6 ? 'the add-auth kumquat invoice is late' : `line ${i} of a long chat`, ts: 1_000_000 + i, byAgent: false }));
  writeFileSync(path.join(dir, 'chats', chat, 'history.json'), JSON.stringify(items));
  await sidebar(page).getByText('Overview', { exact: true }).click();

  await field(page).fill('kumquat');
  const message = results(page).getByRole('option').filter({ hasText: 'kumquat invoice' });
  await expect(message).toBeVisible();
  await shot(page, '01-message-results');
  // No chat is called kumquat: the message is first and See All is next; the arrows move between them.
  const all = results(page).getByRole('option', { name: 'See All in Search' });
  await field(page).press('ArrowDown');
  await expect(all).toHaveAttribute('aria-selected', 'true');
  await field(page).press('ArrowUp');
  await expect(message).toHaveAttribute('aria-selected', 'true');
  await field(page).press('Enter');
  await expect(page.locator('[data-jumped="true"]')).toContainText('kumquat invoice');
  await expect(page.locator('[data-jumped="true"]')).toBeInViewport();
});

test('chats come first, then messages; a short query searches no messages', async ({ page }) => {
  await page.goto('/');
  await openAddAuth(page);
  await composer(page).fill('notes about add-auth and its tokens');
  await composer(page).press('Enter');
  await expect(page.getByText('notes about add-auth and its tokens').last()).toBeVisible();

  await field(page).fill('add-auth');
  const options = results(page).getByRole('option');
  await expect(options.first()).toContainText('add-auth');
  await expect(options.filter({ hasText: 'notes about add-auth' }).first()).toBeVisible();
  await expect(results(page).getByText('Messages', { exact: true })).toBeVisible();
  await shot(page, '02-chat-and-message-results');

  await field(page).fill('ad');
  await expect(results(page).getByText('Messages', { exact: true })).toHaveCount(0);
});

test('Esc clears the query and the sections come back with their folds', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().waitFor();
  const projects = sidebar(page).getByRole('button', { name: 'Projects', exact: true });
  await projects.click();
  await expect(projects).toHaveAttribute('aria-expanded', 'false');

  await field(page).fill('auth');
  await expect(results(page)).toBeVisible();
  await expect(projects).toBeHidden();
  await field(page).press('Escape');
  await expect(field(page)).toHaveValue('');
  await expect(results(page)).toHaveCount(0);
  await expect(projects).toBeVisible();
  await expect(projects).toHaveAttribute('aria-expanded', 'false');
});

test('⌥⌘F focuses the field, also from a hidden sidebar, and is in the shortcuts list', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().waitFor();
  await page.keyboard.press('Alt+Meta+F');
  await expect(field(page)).toBeFocused();
  await field(page).press('Escape');

  await sidebar(page).getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(sidebar(page)).toHaveCount(0);
  await page.keyboard.press('Alt+Meta+F');
  await expect(field(page)).toBeFocused();

  await page.keyboard.press('Meta+/');
  await page.getByRole('textbox', { name: 'Search shortcuts' }).fill('Search in the Sidebar');
  await expect(page.getByText('Search in the Sidebar', { exact: true })).toBeVisible();
});

test('See All opens the Search page on the same query, and the Search page still works by itself', async ({ page }) => {
  await page.goto('/');
  await openAddAuth(page);
  await composer(page).fill('the mulberry key');
  await composer(page).press('Enter');
  await expect(page.getByText('the mulberry key').last()).toBeVisible();

  await field(page).fill('mu');
  await results(page).getByRole('option', { name: 'See All in Search' }).click();
  const box = page.getByPlaceholder('Search every conversation');
  await expect(box).toHaveValue('mu');
  await box.fill('mulberry');
  const hit = page.getByRole('main').getByRole('option').first();
  await expect(hit).toContainText('the mulberry key');
  await box.press('Enter');
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await expect(page.locator('[data-jumped="true"]')).toContainText('the mulberry key');
});
