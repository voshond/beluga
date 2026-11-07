import { expect, test, type Page } from './fixtures.js';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const backButton = (page: Page) => sidebar(page).getByRole('button', { name: 'Back', exact: true });
const shots = process.env.BELUGA_SHOTS;

test('the address follows the view, a reload stays there, and Back goes where you were', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await expect(page).toHaveURL(/#\/room$/);
  await expect(backButton(page)).toBeDisabled();

  await sidebar(page).getByText('Overview', { exact: true }).click();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(backButton(page)).toBeEnabled();
  if (shots) await page.screenshot({ path: `${shots}/01-web-back.png` });

  await page.reload();
  await expect(sidebar(page)).toBeVisible();
  await expect(page).toHaveURL(/#\/overview$/);
  await expect(sidebar(page).getByText('Overview', { exact: true })).toBeVisible();

  await backButton(page).click();
  await expect(page).toHaveURL(/#\/room$/);
  await expect(backButton(page)).toBeDisabled();

  await page.goForward();
  await expect(page).toHaveURL(/#\/overview$/);
});
