import { expect, test, type Page } from './fixtures.js';

/**
 * A browser has no menu bar (BLG-723): the sidebar's top left holds it, Settings first, and the
 * toolbar keeps it while the sidebar is hidden.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const menuButton = (page: Page) => page.getByRole('button', { name: 'Settings and menus' });
const shots = process.env.BELUGA_SHOTS;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the menu button opens Settings, and runs the menu bar’s commands', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'Settings and menus' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem').first()).toHaveText(/Settings…/);
  if (shots) await page.screenshot({ path: `${shots}/01-app-menu.png` });
  await menu.getByRole('menuitem', { name: /Settings…/ }).click();
  await expect(page.getByRole('dialog').getByText('Settings', { exact: true }).first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/02-settings.png` });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  // View › Toggle Sidebar: the button moves into the toolbar, and brings the sidebar back.
  await menuButton(page).click();
  await page.getByRole('menuitem', { name: 'View' }).hover();
  await page.getByRole('menuitem', { name: /Toggle Sidebar/ }).click();
  await expect(sidebar(page)).toBeHidden();
  await expect(menuButton(page)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/03-no-sidebar.png` });
  await menuButton(page).click();
  await page.getByRole('menuitem', { name: 'Keys and Commands' }).click();
  await expect(page.getByRole('heading', { name: 'Keyboard' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(sidebar(page)).toBeVisible();
});
