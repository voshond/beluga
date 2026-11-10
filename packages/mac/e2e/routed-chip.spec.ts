import { expect, test, type Page } from './fixtures.js';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)').last();
const chip = (page: Page) => page.getByRole('button', { name: 'Agent, model and effort' });
const shot = (name: string): string => `../../.beluga/scratch/${name}`;

const openHero = async (page: Page): Promise<void> => {
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name: 'new-hero', exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', /new-hero/);
};

const turnOnRouting = async (page: Page): Promise<void> => {
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('combobox', { name: 'Search settings' }).fill('routed task runs');
  await page.keyboard.press('Enter');
  const toggle = settings.getByRole('switch', { name: 'Routed task runs' });
  if ((await toggle.getAttribute('aria-checked')) === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: shot('chip-01-experimental-on.png') });
  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(settings).toHaveCount(0);
};

test('a routed task’s chip says Auto and the model it routed to; picking a model turns it off, Auto turns it back on', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await openHero(page);
  await expect(chip(page)).not.toContainText('Auto');

  await turnOnRouting(page);
  await expect(chip(page)).toContainText('Auto · Opus');
  await expect(chip(page)).toContainText('High');
  await page.screenshot({ path: shot('chip-02-auto-opus.png') });

  await chip(page).click();
  const models = page.getByRole('radiogroup', { name: 'Claude models' });
  await expect(models.getByRole('radio', { name: /^Auto/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Auto picked High for this task')).toBeVisible();
  await page.screenshot({ path: shot('chip-03-picker-auto.png') });

  await models.getByRole('radio', { name: /^Haiku/ }).click();
  await expect(chip(page)).not.toContainText('Auto');
  await expect(models.getByRole('radio', { name: /^Auto/ })).toHaveAttribute('aria-checked', 'false');
  await page.screenshot({ path: shot('chip-04-picked-haiku.png') });

  await models.getByRole('radio', { name: /^Auto/ }).click();
  await expect(chip(page)).toContainText('Auto · Opus');
});
