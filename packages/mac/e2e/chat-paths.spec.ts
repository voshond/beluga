import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Files and folders a message names (BLG-752) are links: in the words or in backticks, a click
 * opens the file or the folder, and a right-click shows it in Finder or copies its path.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

test('paths in a message open the file or the folder', async ({ page }) => {
  // A path from a folder a Mac really starts at (/tmp, /Users…): the e2e's own temp folder is one.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-paths-'));
  mkdirSync(path.join(dir, 'scratch'));
  writeFileSync(path.join(dir, 'scratch', 'notes.md'), '# Notes\n\nHello from the scratch folder.\n');
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await composer(page).fill(`Notes are in \`${dir}/scratch/notes.md\`, the folder is ${dir}/scratch/ and /api/login stays words.`);
  await composer(page).press('Enter');

  const file = page.getByRole('link', { name: `${dir}/scratch/notes.md` }).last();
  const folder = page.getByRole('link', { name: `${dir}/scratch/` }).last();
  await expect(file).toBeVisible();
  await expect(folder).toBeVisible();
  await expect(page.getByRole('link', { name: '/api/login' })).toHaveCount(0);
  await page.screenshot({ path: '../../.beluga/scratch/01-chat-paths.png' });

  await file.click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Open' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Show in/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible();
  await page.screenshot({ path: '../../.beluga/scratch/02-chat-path-menu.png' });
  await page.keyboard.press('Escape');

  await file.click();
  await expect(page.getByText('Hello from the scratch folder.')).toBeVisible();
  await page.screenshot({ path: '../../.beluga/scratch/03-chat-path-opened.png' });

  // The folder opens in Files, at that folder.
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await page.getByRole('link', { name: `${dir}/scratch/` }).last().click();
  await expect(page.getByText('stays words.')).toBeHidden();
  await expect(page.getByText('notes.md', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: '../../.beluga/scratch/04-chat-path-folder.png' });
});

test('in a worktree, paths relative to it open its files, and a missing one says so', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await composer(page).fill('Look at `src/auth.ts:2`, the src/ folder and .beluga/scratch/gone.png');
  await composer(page).press('Enter');

  const file = page.getByRole('link', { name: 'src/auth.ts:2' }).last();
  await expect(file).toBeVisible();
  await expect(page.getByRole('link', { name: 'src/', exact: true }).last()).toBeVisible();
  await expect.poll(async () => (await file.boundingBox())?.y ?? 0).toBeLessThan(700);
  await page.screenshot({ path: '../../.beluga/scratch/05-worktree-paths.png' });

  // A file of the worktree takes the center, at its line; Esc goes back to the chat.
  await file.click();
  await expect(composer(page)).toBeHidden();
  await expect(page.getByText("throw new Error('unauthorized')").first()).toBeVisible();
  await page.screenshot({ path: '../../.beluga/scratch/06-worktree-file.png' });
  await page.keyboard.press('Escape');
  await expect(composer(page)).toBeVisible();

  await page.getByRole('link', { name: '.beluga/scratch/gone.png' }).last().click();
  await expect(page.getByText(/Can’t find \.beluga\/scratch\/gone\.png/)).toBeVisible();
});
