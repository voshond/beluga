import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Sentinel's code fields in color (BLG-372): a Postgres query, a shell command and a Python script,
 * Tidy laying out SQL, Tab indenting. Screenshots in light and dark go to .beluga/scratch/code-*.png.
 */

const shots = path.join(import.meta.dirname, '..', '..', '..', '.beluga', 'scratch');
const main = (page: Page) => page.locator('main');
async function shoot(page: Page, el: ReturnType<Page['locator']>, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await el.screenshot({ path: path.join(shots, `code-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}
async function open(page: Page, name: RegExp) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^Sentinel/ }).click();
  await expect(main(page).locator('[data-sentinel]').first()).toBeVisible({ timeout: 20_000 });
  await main(page).getByRole('row', { name }).click();
}

test('query, script and command editors are colored; Tidy lays out SQL', async ({ page }) => {
  await open(page, /^Last job run/);
  const steps = main(page).getByRole('region', { name: 'Steps' });
  const measure = steps.locator('[data-step="measure"]');
  await measure.getByRole('button', { name: 'Show its fields' }).click();
  const q = measure.getByRole('textbox', { name: 'Query' });
  await q.fill("select who, job, status, finished_at from job_runs where status <> 'ok' and finished_at > now() - interval '1 day' order by finished_at desc limit 20");
  await q.blur();
  await page.waitForTimeout(600);
  await shoot(page, measure, 'query-before');
  await q.hover();
  await measure.getByRole('button', { name: 'Tidy' }).click();
  await expect(q).toHaveValue(/^SELECT\n/);
  await page.waitForTimeout(600);
  await shoot(page, measure, 'query-tidy');
  await q.click();
  await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.press('End');
  await page.keyboard.type(' -- typed');
  await expect(q).toHaveValue(/-- typed$/);

  await open(page, /^Site speed/);
  const script = main(page).getByRole('region', { name: 'Steps' }).locator('[data-step="script"]').first();
  await script.getByRole('button', { name: 'Show its fields' }).click();
  await shoot(page, script, 'command');
  await script.getByRole('tab', { name: 'Its own script' }).click();
  const code = script.getByRole('textbox', { name: 'Script' });
  await code.click();
  await page.keyboard.press('Meta+End');
  await page.keyboard.type('\nfor i in range(3):\n');
  await page.keyboard.press('Tab');
  await page.keyboard.type('print(f"run {i}", os.environ.get("SENTINEL_PREVIOUS"))  # a comment');
  await page.waitForTimeout(600);
  await shoot(page, script, 'python');
});
