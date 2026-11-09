import { expect, test, type Page } from './fixtures.js';

/**
 * Files: searching what's in the files (a line opens the file there), and a file that opens
 * read-only until Edit, then Save (⌘S) writes it, and Done with changes not saved asks first.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)').first();
const tab = (page: Page, name: string) => panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name, exact: true });

async function openHero(page: Page): Promise<void> {
  await expect(sidebar(page).getByRole('button', { name: 'landing' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible()))
    await sidebar(page)
      .getByRole('button', { name: 'landing' })
      .first()
      .click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /new-hero/);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('Contents search finds lines by file and opens the file at the line', async ({ page }, info) => {
  await openHero(page);
  await tab(page, 'Files').click();
  await panel(page).getByRole('radiogroup', { name: 'Search' }).getByRole('radio', { name: 'Contents' }).click();
  const box = panel(page).getByRole('textbox', { name: 'Search in the files’ contents' });
  await box.fill('Pricing');
  const hits = panel(page).getByRole('tree', { name: 'Lines found' });
  await expect(hits.getByRole('status')).toContainText(/\d+ lines? in \d+ files?/);
  await expect(hits.locator('mark').first()).toHaveText(/pricing/i);
  await page.screenshot({ path: info.outputPath('01-content-search.png') });
  // The README's Pricing row: it opens as source, at that line.
  await hits.locator('[title^="README.md:"]').first().click();
  const file = panel(page).getByRole('region', { name: 'README.md' });
  await expect(file.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(file.locator('pre code')).toContainText('Pricing');
  await page.screenshot({ path: info.outputPath('02-opened-at-line.png') });
});

test('a file opens read-only; Edit, type, ⌘S saves it; Done with unsaved changes asks', async ({ page }, info) => {
  await openHero(page);
  await tab(page, 'Files').click();
  await panel(page).getByRole('radiogroup', { name: 'Search' }).getByRole('radio', { name: 'Names' }).click();
  await panel(page).getByRole('treeitem', { name: 'README.md' }).click();
  const file = panel(page).getByRole('region', { name: 'README.md' });
  // Read-only: no text box until Edit.
  await expect(file.getByRole('textbox')).toHaveCount(0);
  await file.getByRole('button', { name: 'Edit', exact: true }).click();
  const area = file.getByRole('textbox', { name: 'Edit README.md' });
  await expect(area).toBeFocused();
  // The demo project has no Prettier: Format is there, off, and says why.
  const format = file.getByRole('button', { name: /Prettier isn’t installed/ });
  await expect(format).toHaveAttribute('aria-disabled', 'true');
  await format.hover();
  await expect(page.getByRole('tooltip')).toContainText('Prettier isn’t installed in this project');
  await page.screenshot({ path: info.outputPath('04-format-off.png'), clip: (await file.boundingBox()) ?? undefined });
  await page.mouse.move(0, 0);
  await expect(area).toBeFocused();
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  await page.keyboard.type('Edited here\n');
  await expect(file.getByRole('status').filter({ hasText: 'Edited' })).toBeVisible();
  await expect(file.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.waitForTimeout(300);
  // The text box's selection sits on the drawn text (they line up).
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Shift+Alt+ArrowRight');
  await page.screenshot({ path: info.outputPath('03-editing.png'), clip: (await file.boundingBox()) ?? undefined });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(file.getByRole('status').filter({ hasText: 'Editing' })).toBeVisible();
  // Saved: Done goes straight back to read-only, and the file (read again from disk) has the line.
  await file.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(file.getByRole('textbox')).toHaveCount(0);
  await file.getByRole('tab', { name: 'Source' }).click();
  await expect(file.locator('pre code')).toContainText('Edited here');
  // Unsaved again, then Done: it asks; Discard goes back to read-only.
  await file.getByRole('button', { name: 'Edit', exact: true }).click();
  await area.press('End');
  await page.keyboard.type(' more');
  await file.getByRole('button', { name: 'Done', exact: true }).click();
  const alert = page.getByRole('alertdialog');
  await expect(alert).toContainText('Discard your changes to README.md?');
  await alert.getByRole('button', { name: 'Discard' }).click();
  await expect(file.getByRole('textbox')).toHaveCount(0);
  await expect(file.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
});
