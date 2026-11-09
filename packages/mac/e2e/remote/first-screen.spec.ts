import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '../fixtures.js';

/**
 * The first screen of a computer's file (BLG-853), measured in the app: with 80 ms added round trip
 * (the `remote` project), a click on a file in Files shows its first lines, its real ones, and a
 * click on a changed file shows its diff, each timed from the click to the frame after the first
 * line is drawn (the reader's and the diff's own marks, lib/first-paint.ts).
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../../.beluga/scratch');
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const tab = (page: Page, name: string) => panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name, exact: true });
const timings: Record<string, number> = {};

async function openThere(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Your Computers', exact: true }).click();
  await settings.getByRole('button', { name: 'Open webhook-retries on build-box' }).click();
  await expect(page.getByTitle(/Runs on build-box/)).toBeVisible();
}

/** The worktree's folder (the demo's computer is this same daemon, so it's on this disk). */
const worktreePath = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const st = (window as unknown as { __belugaState: () => { projects: Array<{ workspaces: Array<{ name: string; path: string }> }> } }).__belugaState();
    return st.projects.flatMap((p) => p.workspaces).find((w) => w.name === 'webhook-retries')!.path;
  });

/** Click `row` and time it to the frame after `mark` is set for `key` (ms). */
async function clickToMark(page: Page, row: Locator, mark: string, key: string): Promise<number> {
  await page.evaluate(() => performance.clearMarks());
  const clicked = await row.evaluate((el) => {
    const at = performance.now();
    (el as HTMLElement).click();
    return at;
  });
  const shown = await expect
    .poll(() => page.evaluate(([m, k]) => (performance.getEntriesByName(m!) as PerformanceMark[]).find((e) => e.detail === k)?.startTime ?? 0, [mark, key]), { timeout: 10_000 })
    .not.toBe(0)
    .then(() => page.evaluate(([m, k]) => (performance.getEntriesByName(m!) as PerformanceMark[]).find((e) => e.detail === k)!.startTime, [mark, key]));
  return Math.round(shown - clicked);
}

const firstLines = (text: string, n = 3): string[] =>
  text
    .split('\n')
    // A Markdown file is drawn formatted: its words, without the marks.
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, n);

test.afterAll(() => {
  writeFileSync(path.join(SHOTS, 'blg-853-timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
});

test('a file in Files shows its real first lines under 150 ms after the click, hovered first', async ({ page }) => {
  await openThere(page);
  const dir = await worktreePath(page);
  await tab(page, 'Files').click();
  const files = panel(page).locator('[role="treeitem"]:not([aria-expanded])');
  await expect(files.nth(1)).toBeVisible();
  const hovered = files.first();
  const cold = files.nth(1);
  const hoveredName = (await hovered.getAttribute('aria-label'))!;
  const coldName = (await cold.getAttribute('aria-label'))!;

  // Under the pointer a moment (it's read ahead), then the click.
  await hovered.hover();
  await page.waitForTimeout(400);
  timings.hoveredFile = await clickToMark(page, hovered, 'beluga:file-shown', hoveredName);
  const shown = panel(page).getByRole('region', { name: hoveredName, exact: true });
  for (const line of firstLines(readFileSync(path.join(dir, hoveredName), 'utf8'))) await expect(shown).toContainText(line);
  await page.screenshot({ path: path.join(SHOTS, 'blg-853-hovered-file.png') });

  // Never under the pointer: one round trip more, said in the timings.
  await page.mouse.move(5, 5);
  timings.notHoveredFile = await clickToMark(page, cold, 'beluga:file-shown', coldName);
  const coldShown = panel(page).getByRole('region', { name: coldName, exact: true });
  for (const line of firstLines(readFileSync(path.join(dir, coldName), 'utf8'))) await expect(coldShown).toContainText(line);

  expect(timings.hoveredFile).toBeLessThan(150);
  expect(timings.notHoveredFile).toBeLessThan(300);
});

test('a changed file’s diff draws under 150 ms after the click', async ({ page }) => {
  await openThere(page);
  const dir = await worktreePath(page);
  // A change to a file it tracks, so there's a diff with lines.
  const readme = path.join(dir, 'README.md');
  appendFileSync(readme, '\nRetries back off: 1 s, 2 s, 4 s, then give up.\n');
  await tab(page, 'Changes').click();
  await panel(page).getByRole('button', { name: 'Look again' }).click();
  const row = panel(page).getByRole('option', { name: /README\.md/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  // The other changed file first, so README.md's diff isn't already here.
  await panel(page).getByRole('option', { name: /webhooks\.ts/ }).click();
  await expect(panel(page).getByRole('region', { name: 'Changes in webhooks.ts' }).getByText('No differences in the text.')).toBeVisible();
  // The edit is read again by itself as well: let that settle first.
  await page.waitForTimeout(1500);
  // Still on webhooks.ts: README.md's diff isn't on screen or picked yet.
  await expect(panel(page).getByRole('region', { name: 'Changes in webhooks.ts' })).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'Changes in README.md' })).toHaveCount(0);
  await row.hover();
  await page.waitForTimeout(400);
  timings.diff = await clickToMark(page, row, 'beluga:diff-shown', 'README.md');
  const change = panel(page).getByRole('region', { name: 'Changes in README.md' });
  await expect(change).toContainText('Retries back off');
  await page.screenshot({ path: path.join(SHOTS, 'blg-853-diff.png') });
  expect(timings.diff).toBeLessThan(150);
});
