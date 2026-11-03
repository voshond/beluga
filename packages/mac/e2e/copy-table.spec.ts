import { expect, test, type Page } from './fixtures.js';

/** A table in an answer copies with one click: HTML for Sheets and Docs, Markdown as its text (BLG-336). */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

test('Copy Table puts the whole table on the clipboard', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 90_000 });
  await composer(page).fill('show me the data');
  await composer(page).press('Enter');

  // The plain Markdown table in the answer (providers): its Copy shows on hover.
  const table = page.getByRole('figure', { name: 'Table' }).filter({ hasText: 'Adyen' }).last();
  await expect(table).toBeVisible({ timeout: 30_000 });
  await table.hover();
  await table.getByRole('button', { name: 'Copy Table' }).click();
  await expect(page.getByText('Copied 9 rows').last()).toBeVisible();
  await expect(table.getByRole('button', { name: 'Copied' })).toBeVisible();

  const { text, html } = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return { text: await (await item!.getType('text/plain')).text(), html: await (await item!.getType('text/html')).text() };
  });
  expect(text.split('\n').slice(0, 3)).toEqual(['| Provider | Success rate | p95 | Fee |', '| --- | ---: | ---: | ---: |', expect.stringMatching(/^\| Stripe \| 97\.7% \|/)]);
  expect(html).toContain('<th>Provider</th>');
  expect(html).toContain('<td>Adyen</td>');
  await page.screenshot({ path: '../../.beluga/scratch/01-copy-table.png', clip: (await table.boundingBox())! });

  // ••• › Copy as › JSON: the rows themselves, raw values under their keys (BLG-591).
  await table.hover();
  await table.getByRole('button', { name: 'Copy or Save As' }).click();
  await page.getByRole('menuitem', { name: 'Copy as' }).hover();
  await expect(page.getByRole('menuitem', { name: 'SQL Inserts' })).toBeVisible();
  const box = await page.locator('[role="menu"]').last().boundingBox();
  const tableBox = (await table.boundingBox())!;
  await page.screenshot({ path: '../../.beluga/scratch/02-copy-as-menu.png', clip: { x: tableBox.x, y: tableBox.y, width: Math.max(tableBox.width, box!.x + box!.width - tableBox.x + 8), height: Math.max(tableBox.height, box!.y + box!.height - tableBox.y + 8) } });
  await page.getByRole('menuitem', { name: 'JSON', exact: true }).click();
  await expect(page.getByText('Copied 9 rows as JSON').last()).toBeVisible();
  const json = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as Record<string, unknown>[];
  expect(json).toHaveLength(9);
  expect(json[0]).toMatchObject({ Provider: 'Stripe', 'Success rate': 97.7 });
});
