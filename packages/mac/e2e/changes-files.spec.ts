import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { demoPortrait } from '../../../src/demo-image.js';
import { demoPdf } from '../../../src/demo-pdf.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * Changes and Files, side by side: a changed file shows as itself too (Markdown formatted,
 * pictures and PDFs as they look), each tab jumps to the other for the same file, and the
 * panel's tabs keep the one you're on readable however narrow the panel is.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const tab = (page: Page, name: string) => panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name, exact: true });

async function openHero(page: Page): Promise<void> {
  await expect(sidebar(page).getByRole('button', { name: 'landing' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /new-hero/);
}

async function pickChange(page: Page, name: RegExp) {
  await tab(page, 'Changes').click();
  await panel(page).getByRole('option', { name }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('a narrow panel still names its tabs in full; History is a view inside Changes', async ({ page }) => {
  await openHero(page);
  await tab(page, 'Changes').click();
  // Never "Ch…", never icons only.
  for (const name of ['Changes', 'Files', 'Scratch', 'Info', 'Terminal', 'Background']) {
    const label = tab(page, name).locator('span > span');
    expect(await label.evaluate((el) => el.clientWidth > 10 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  const views = panel(page).getByRole('radiogroup', { name: 'Changes views' });
  await views.getByRole('radio', { name: 'History' }).click();
  await expect(tab(page, 'Changes')).toHaveAttribute('aria-selected', 'true');
  await expect(views.getByRole('radio', { name: 'History' })).toHaveAttribute('aria-checked', 'true');
  // Back to Files and to Changes again: History is where it left off.
  await tab(page, 'Files').click();
  await tab(page, 'Changes').click();
  await expect(views.getByRole('radio', { name: 'History' })).toHaveAttribute('aria-checked', 'true');
  await views.getByRole('radio', { name: 'Changes' }).click();
});

test('Changes shows a picture and a PDF as themselves, not as a binary diff', async ({ page }) => {
  await openHero(page);
  await pickChange(page, /hero-shot\.png/);
  const shot = panel(page).getByRole('region', { name: 'Changes in hero-shot.png' });
  await expect(shot.getByRole('img', { name: /hero-shot\.png/ })).toBeVisible();
  await pickChange(page, /brand-brief\.pdf/);
  const pdf = panel(page).getByRole('region', { name: 'Changes in brand-brief.pdf' });
  await expect(pdf.getByRole('img', { name: 'Page 1' })).toBeVisible();
  await expect(pdf.getByRole('img', { name: 'Page 2' })).toBeAttached();
});

test('a changed README: its diff, or formatted; Show in Files and back with Show Changes', async ({ page }) => {
  await openHero(page);
  await pickChange(page, /README\.md/);
  const readme = panel(page).getByRole('region', { name: 'Changes in README.md' });
  await expect(readme.locator('tr').first()).toBeVisible();
  await readme.getByRole('tab', { name: 'Preview' }).click();
  await expect(readme.getByRole('heading', { name: 'Landing page' })).toBeVisible();
  await expect(readme.getByRole('table')).toContainText('Pricing');
  // The same file in Files, and from there back to its changes.
  await readme.getByRole('button', { name: 'Show in Files' }).click();
  await expect(tab(page, 'Files')).toHaveAttribute('aria-selected', 'true');
  const file = panel(page).getByRole('region', { name: 'README.md' });
  await expect(file.getByRole('heading', { name: 'Landing page' })).toBeVisible();
  await file.getByRole('button', { name: 'Show Changes' }).click();
  await expect(tab(page, 'Changes')).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByRole('region', { name: 'Changes in README.md' })).toBeVisible();
  // Back to the diff (the choice is kept for the next file too).
  await panel(page).getByRole('region', { name: 'Changes in README.md' }).getByRole('tab', { name: 'Changes' }).click();
  await expect(panel(page).getByRole('region', { name: 'Changes in README.md' }).locator('tr').first()).toBeVisible();
});

test('Files opens a PDF (no more “binary file”), and in full it has zoom', async ({ page }) => {
  await openHero(page);
  await tab(page, 'Files').click();
  const docs = panel(page).getByRole('treeitem', { name: 'docs' });
  await expect(docs).toBeVisible();
  if ((await docs.getAttribute('aria-expanded')) !== 'true') await docs.click();
  await panel(page).getByRole('treeitem', { name: 'brand-brief.pdf' }).click();
  const preview = panel(page).getByRole('region', { name: 'brand-brief.pdf' });
  await expect(preview.getByRole('img', { name: 'Page 1' })).toBeVisible();
  await expect(preview).not.toContainText('binary file');
  await preview.getByRole('button', { name: 'Open in full' }).click();
  const full = page.getByRole('main').getByRole('region', { name: 'brand-brief.pdf' });
  await expect(full.getByRole('img', { name: 'Page 1' })).toBeVisible();
  await expect(full.getByRole('toolbar', { name: 'Zoom' })).toContainText('2 pages');
  await page.keyboard.press('Escape');
});

test('the full-size diff has Preview next to Unified and Split', async ({ page }) => {
  await openHero(page);
  await pickChange(page, /README\.md/);
  await page.keyboard.press('Meta+Enter');
  const main = page.getByRole('main');
  await expect(main.getByRole('tablist', { name: 'Layout' }).getByRole('tab')).toHaveText(['Unified', 'Split', 'Preview']);
  await main.getByRole('tab', { name: 'Preview' }).click();
  await expect(main.getByRole('heading', { name: 'Landing page' })).toBeVisible();
  // A picture has no layouts: it's just the picture.
  await main.getByRole('listbox', { name: 'Files' }).getByRole('option', { name: /hero-shot\.png/ }).click();
  await expect(main.getByRole('img', { name: /hero-shot\.png/ })).toBeVisible();
  await expect(main.getByRole('tablist', { name: 'Layout' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a picture or a PDF written again shows the new one in Changes, without opening it again (BLG-670)', async ({ page }) => {
  const root = (await sidebar(page).locator('[title$="/landing"]').first().getAttribute('title'))!;
  await openHero(page);
  const trees = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const hero = /^worktree (.*\/new-hero)$/m.exec(trees)![1]!;
  await pickChange(page, /hero-shot\.png/);
  const shot = panel(page).getByRole('region', { name: 'Changes in hero-shot.png' }).getByRole('img', { name: /hero-shot\.png/ });
  const width = () => shot.evaluate((img: HTMLImageElement) => img.naturalWidth);
  await expect.poll(width).toBe(720);
  // Re-recorded (still "modified", the same +0 −0): the new picture, not the one read before.
  writeFileSync(path.join(hero, 'public', 'hero-shot.png'), demoPortrait(64));
  await expect.poll(width, { timeout: 10_000 }).toBe(64);
  // A PDF too: the brief, cut to one page.
  await pickChange(page, /brand-brief\.pdf/);
  const pdf = panel(page).getByRole('region', { name: 'Changes in brand-brief.pdf' });
  await expect(pdf.getByRole('img', { name: 'Page 2' })).toBeAttached();
  writeFileSync(path.join(hero, 'docs', 'brand-brief.pdf'), demoPdf(1));
  await expect(pdf.getByRole('img', { name: 'Page 2' })).toHaveCount(0, { timeout: 10_000 });
  await expect(pdf.getByRole('img', { name: 'Page 1' })).toBeVisible();
});
