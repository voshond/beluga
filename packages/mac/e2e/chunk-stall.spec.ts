import { expect, test, type Page } from './fixtures.js';

/**
 * A part of the window whose code never arrives (WebView2 on Windows, after long uptime, #370)
 * says so after a while instead of staying blank, notes it in the daemon's black box, and Reload
 * brings it back. Here the dev server's module for the view is held forever.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });

/** Hold every request for a module forever, as the stalled origin did. */
async function stall(page: Page, module: RegExp): Promise<void> {
  await page.route(module, () => undefined);
}

/** The window's notes to the daemon about chunks that didn't load. */
function notes(page: Page): string[] {
  const seen: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && f.payload.includes('diagnostics.windowProblem') && seen.push(f.payload)));
  return seen;
}

test.setTimeout(120_000);

test('a project page whose code never arrives says so, and Reload brings it back', async ({ page }, info) => {
  const sent = notes(page);
  await stall(page, /\/src\/views\/ProjectHome\.tsx/);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByText('landing', { exact: true }).first().click();
  const main = page.getByRole('main');
  await expect(main.getByText('This view didn’t finish loading')).toBeVisible({ timeout: 45_000 });
  await page.screenshot({ path: info.outputPath('01-project-stalled.png') });
  await expect.poll(() => sent.some((s) => s.includes('views/ProjectHome') && s.includes('stalled'))).toBe(true);

  await page.unroute(/\/src\/views\/ProjectHome\.tsx/);
  await main.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'landing' })).toBeVisible({ timeout: 20_000 });
  await expect(main.getByText('This view didn’t finish loading')).toHaveCount(0);
});

test('a file preview whose reader never arrives says so under its header, the tree still there', async ({ page }, info) => {
  await stall(page, /\/src\/views\/reader\/FileReader\.tsx/);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByText('landing', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'landing' })).toBeVisible();
  if (!(await panel(page).isVisible())) await page.keyboard.press('ControlOrMeta+Alt+0');
  await panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name: 'Files', exact: true }).click();
  const tree = panel(page).getByRole('tree', { name: 'Files' });
  await tree.getByRole('treeitem', { name: 'README.md' }).click();
  const file = panel(page).getByRole('region', { name: 'README.md' });
  await expect(file.getByText('This view didn’t finish loading')).toBeVisible({ timeout: 45_000 });
  // Only the body: the pane's header and the tree stay.
  await expect(file.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'README.md' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('02-reader-stalled.png') });
});
