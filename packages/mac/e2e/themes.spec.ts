import { expect, test } from './fixtures.js';

const SHOTS = process.env.THEME_SHOTS;

/** Settings › Appearance › the themes (BLG-696): one picked shows at once, with its own colours and accent, and is remembered. */
test('A theme picked in Settings repaints the window and is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Appearance' }).click();
  const dark = page.getByRole('radiogroup', { name: 'Dark theme' });
  await expect(dark.getByRole('radio', { name: 'Dark', exact: true })).toHaveAttribute('aria-checked', 'true');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-settings-dark.png` });

  await dark.getByRole('radio', { name: 'OLED Black' }).click();
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveAttribute('data-palette', 'oled');
  // True black, with nothing of the window's blur behind it.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())).toBe('#000000');
  await expect(html).toHaveAttribute('data-transparency', 'reduce');
  // Its surfaces edged in light, since no shadow shows on black.
  await expect(html).toHaveAttribute('data-edges', 'lit');
  // Its own accent, taken over from the system's.
  await expect(page.getByRole('button', { name: 'OLED Black’s own' })).toHaveAttribute('aria-pressed', 'true');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/02-settings-oled.png` });

  // A light one from the dark: the window turns light to show it.
  await page.getByRole('radiogroup', { name: 'Light theme' }).getByRole('radio', { name: 'Catppuccin Latte' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(html).toHaveAttribute('data-palette', 'latte');

  await page.reload();
  await expect(html).toHaveAttribute('data-palette', 'latte');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  // Back to dark, the dark theme you picked is still OLED.
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Appearance' }).click();
  await page.getByRole('combobox', { name: 'Appearance' }).click();
  await page.getByRole('option', { name: 'Dark', exact: true }).click();
  await expect(html).toHaveAttribute('data-palette', 'oled');
});

/** Every theme over the app's main window (only when THEME_SHOTS names a folder for the pictures). */
test('Each theme over the window', async ({ page }) => {
  test.skip(!SHOTS, 'pictures only');
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  const ids = ['super-dark', 'oled', 'abyss', 'dracula', 'mocha', 'tokyo-night', 'nord', 'gruvbox', 'rose-pine', 'arctic', 'latte', 'solarized-light'];
  for (const id of ids) {
    await page.evaluate(async (theme) => {
      const prefs = await import('/src/lib/prefs.ts');
      prefs.setPrefs({ accent: 'theme' });
      prefs.pickTheme(theme);
    }, id);
    await expect(page.locator('html')).toHaveAttribute('data-palette', id);
    // Past the colours' fade.
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/window-${id}.png` });
  }
});
