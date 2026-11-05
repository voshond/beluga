import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Git on the project home and in History, on the demo's landing project (several people, merged
 * branches, a tag, and 3 commits on origin/main you haven't pulled): the history graph, a
 * commit's diff, the panel's History tab, then Update main (a fast-forward, and changes in the
 * way set aside and put back). The tests run in order: the updates come last.
 */

test.describe.configure({ mode: 'serial' });

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=e2e@beluga.dev', '-c', 'user.name=E2E Teammate', ...args], { cwd, stdio: 'pipe' }).toString();
const LINES = Array.from({ length: 12 }, (_, i) => `note ${i + 1}`);
const notes = (edits: Record<number, string> = {}) => `${LINES.map((l, i) => edits[i] ?? l).join('\n')}\n`;

async function openLanding(page: Page): Promise<string> {
  const row = sidebar(page).locator('[title$="/landing"]').first();
  await expect(row).toBeVisible();
  const root = (await row.getAttribute('title'))!;
  await sidebar(page).getByText('landing', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'landing' })).toBeVisible();
  return root;
}

/** A teammate's clone of landing's origin that pushes a commit. */
function teammatePushes(root: string, file: string, content: string, message: string): void {
  const origin = git(root, 'remote', 'get-url', 'origin').trim();
  const clone = mkdtempSync(path.join(os.tmpdir(), 'beluga-e2e-mate-'));
  git(clone, 'clone', '-q', origin, '.');
  writeFileSync(path.join(clone, file), content);
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', message);
  git(clone, 'push', '-q', 'origin', 'main');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the project home shows main behind origin, with Update main and the latest history', async ({ page }) => {
  await openLanding(page);
  await expect(page.getByText('3 behind origin/main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update main' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fetch' })).toBeVisible();
  await expect(page.getByText(/fetched .*ago|fetched just now/)).toBeVisible();
  // Not a fork: nothing fork-only shows (BLG-726).
  await expect(page.getByRole('button', { name: 'Sync Fork' })).toHaveCount(0);
  await expect(page.getByText(/ new on /)).toHaveCount(0);
  const history = page.getByRole('region', { name: 'History' });
  await expect(history.getByText('3 incoming from origin/main', { exact: false })).toBeVisible();
  const latest = history.getByRole('listbox', { name: 'Latest commits' });
  await expect(latest.getByRole('option', { name: /Update the pricing copy, Bob Rivera, .*not in your checkout yet/ })).toBeVisible();
  await expect(latest.getByRole('option', { name: /Add launch announcement banner/ })).toBeVisible();
});

test('History lists every branch with the graph, and filters by author and path', async ({ page }) => {
  await openLanding(page);
  await page.getByRole('region', { name: 'History' }).getByRole('button', { name: 'Show All' }).click();
  const list = page.getByRole('region', { name: 'Commits' }).getByRole('listbox', { name: 'Commits' });
  await expect(list.getByRole('option', { name: /Dark mode: toggle in the nav, Mia Chen/ })).toBeVisible();
  await expect(list.getByRole('option', { name: /Merge branch 'feat\/blog'/ })).toBeVisible();
  await expect(list.getByRole('option', { name: /^Initial commit/ })).toBeVisible();
  // The graph: a lane line and a dot in every row, merges reaching over in another color.
  const merge = list.getByRole('option', { name: /Merge branch 'feat\/blog'/ });
  await expect(merge.locator('svg circle')).not.toHaveCount(0);
  expect(new Set(await list.locator('svg path').evaluateAll((ps) => ps.map((p) => p.getAttribute('stroke')))).size).toBeGreaterThan(2);
  await expect(merge.getByText('v0.1')).toBeVisible();
  // Whose commits.
  await page.getByRole('combobox', { name: 'Author' }).click();
  await page.getByRole('listbox', { name: 'Author' }).getByRole('option', { name: /Sam Okafor/ }).click();
  await expect(list.getByRole('option')).toHaveCount(3);
  await expect(list.getByRole('option', { name: /RSS feed for the blog/ })).toBeVisible();
  // And which files.
  await page.getByRole('combobox', { name: 'Author' }).click();
  await page.getByRole('listbox', { name: 'Author' }).getByRole('option', { name: 'Everyone' }).click();
  await page.getByLabel('Path').fill('Pricing');
  await expect(list.getByRole('option')).toHaveCount(3);
  await expect(list.getByRole('option', { name: /Update the pricing copy/ })).toBeVisible();
});

test('a commit shows its message, files and diff, and what to do with it', async ({ page }) => {
  await openLanding(page);
  await page.getByRole('region', { name: 'History' }).getByRole('button', { name: 'Show All' }).click();
  await page.getByRole('option', { name: /RSS feed for the blog/ }).click();
  const detail = page.getByRole('region', { name: 'Commit details' });
  await expect(detail.getByRole('heading', { name: 'RSS feed for the blog' })).toBeVisible();
  await expect(detail.getByText('Sam Okafor')).toBeVisible();
  await expect(detail.getByText('sam@okafor.dev')).toBeVisible();
  await expect(detail.getByText('1 file changed')).toBeVisible();
  await expect(detail.getByText('export const GET = () => rss({ title: "Beluga blog" });')).toBeVisible();
  for (const name of ['Copy Hash', 'Ask Claude About This Commit', 'Start a Worktree Here']) await expect(detail.getByRole('button', { name })).toBeVisible();
  // A parent opens that commit.
  await detail.locator('dd').getByRole('button').first().click();
  await expect(detail.getByRole('heading', { name: 'Blog index page' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Commit details' })).toHaveCount(0);
});

test('the panel’s History tab lists commits and opens one in place', async ({ page }) => {
  await openLanding(page);
  await page.keyboard.press('Alt+Meta+Digit5');
  const panel = page.getByRole('complementary', { name: 'Panel' });
  await expect(panel.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  const list = panel.getByRole('listbox', { name: 'Commits' });
  await expect(list.getByRole('option', { name: /Update the pricing copy/ })).toBeVisible();
  await list.getByRole('option', { name: /Testimonials section/ }).click();
  await expect(panel.getByRole('heading', { name: 'Testimonials section' })).toBeVisible();
  await panel.getByRole('button', { name: 'All Commits' }).click();
  await expect(list.getByRole('option', { name: /Testimonials section/ })).toBeVisible();
});

test('Update main fast-forwards a clean main', async ({ page }) => {
  await openLanding(page);
  await page.getByRole('button', { name: 'Update main' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'main is up to date (3 new commits)' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Up to date with origin/main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update main' })).toHaveCount(0);
});

test('changes in the way: stash, update, and put them back', async ({ page }) => {
  const root = await openLanding(page);
  teammatePushes(root, 'notes.txt', notes(), 'Add notes');
  await page.getByRole('button', { name: 'Fetch' }).click();
  await expect(page.getByText('1 behind origin/main')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Update main' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'main is up to date (1 new commit)' })).toBeVisible({ timeout: 15_000 });
  // Now a teammate edits the top of the file while you edit its end, uncommitted.
  teammatePushes(root, 'notes.txt', notes({ 0: 'from the teammate' }), 'Edit the notes');
  writeFileSync(path.join(root, 'notes.txt'), notes({ 11: 'mine, not committed' }));
  await page.getByRole('button', { name: 'Fetch' }).click();
  await expect(page.getByText('1 behind origin/main')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Update main' }).click();
  const alert = page.getByRole('alertdialog', { name: 'Your uncommitted changes are in the way' });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert.getByText('notes.txt')).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Move to Worktree' })).toBeVisible();
  await alert.getByRole('button', { name: 'Stash and Update' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'main is up to date (1 new commit) · your changes are back' })).toBeVisible({ timeout: 15_000 });
  expect(readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe(notes({ 0: 'from the teammate', 11: 'mine, not committed' }));
  expect(git(root, 'stash', 'list').trim()).toBe('');
  // Leave the demo's main folder clean for the other tests.
  git(root, 'checkout', '--', 'notes.txt');
});
