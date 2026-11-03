import { expect, test, type Page } from './fixtures.js';

/** Live elements Claude shows (docs/views.md): stats, a chart, a table paged from a command, code and colors. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const SHOTS = process.env.VIEW_SHOTS;

async function openWorkspace(page: Page, name: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

async function untilIdle(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 90_000 });
}

async function shot(page: Page, name: string, el?: ReturnType<Page['locator']>): Promise<void> {
  if (!SHOTS) return;
  await (el ?? page).screenshot({ path: `${SHOTS}/${name}.png` });
}

test('shows data live: stats, a chart, a table that pages itself, code and colors', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await openWorkspace(page, 'webhook-retries');
  await untilIdle(page);
  await composer(page).fill('show me the payments dashboard');
  await composer(page).press('Enter');

  // Small elements inside the words: a color is its swatch, a status a badge, a progress bar.
  const intro = page.getByText(/Here’s the payments dashboard/).last();
  await expect(intro.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '63');
  await expect(intro.getByText('in review')).toBeVisible();
  await shot(page, 'views-00-inline', intro);

  const stats = page.getByRole('figure', { name: 'Stats: Payments this week' }).last();
  await expect(stats).toContainText('Revenue');
  await expect(stats).toContainText('$48,210');
  await expect(stats).toContainText('+12.4%');

  const chart = page.getByRole('figure', { name: 'Chart: Payments per day' }).last();
  await expect(chart.locator('svg.recharts-surface, .recharts-wrapper svg').first()).toBeVisible({ timeout: 15_000 });
  await expect(chart.getByRole('button', { name: 'Card' })).toBeVisible();
  // The legend turns a series off and on.
  await chart.getByRole('button', { name: 'Wallet' }).click();
  await expect(chart.getByRole('button', { name: 'Wallet' })).toHaveAttribute('aria-pressed', 'false');
  await chart.getByRole('button', { name: 'Wallet' }).click();

  // A command source asks before it runs the first time (the run's daemon remembers a yes another test gave).
  const orders = page.getByRole('figure', { name: 'Table: Latest orders' }).last();
  await orders.scrollIntoViewIfNeeded();
  const load = orders.getByRole('button', { name: 'Load' });
  const first = orders.getByRole('cell', { name: '1001', exact: true });
  await expect(load.or(first)).toBeVisible({ timeout: 15_000 });
  if (await load.isVisible()) {
    await shot(page, 'views-01-approve', orders);
    await load.click();
  }
  await expect(first).toBeVisible({ timeout: 15_000 });
  await expect(orders.getByText('customer-001@example.com')).toBeVisible();
  // The next page comes from the source, without Claude.
  await orders.getByRole('button', { name: 'Next Page' }).click();
  await expect(orders.getByRole('cell', { name: '1009', exact: true })).toBeVisible();
  await expect(orders.getByText('Page 2')).toBeVisible();
  await shot(page, 'views-02-orders', orders);

  // A table of numbers turns into a chart and back.
  const breakdown = page.getByRole('figure', { name: 'Table: Failures by reason' }).last();
  await breakdown.scrollIntoViewIfNeeded();
  await breakdown.getByRole('columnheader', { name: /Count/ }).getByRole('button').click();
  await expect(breakdown.locator('tbody tr').first()).toContainText('card_declined');
  await breakdown.getByRole('columnheader', { name: /Count/ }).getByRole('button').click();
  await expect(breakdown.locator('tbody tr').first()).toContainText('authentication_required');
  await shot(page, 'views-03-breakdown-table', breakdown);
  await breakdown.getByRole('radio', { name: 'Bar Chart' }).click();
  await expect(breakdown.locator('svg.recharts-surface, .recharts-wrapper svg').first()).toBeVisible({ timeout: 15_000 });
  if (SHOTS) await page.waitForTimeout(1600);
  await shot(page, 'views-04-breakdown-bars', breakdown);
  await breakdown.getByRole('radio', { name: 'Table' }).click();

  // Controls Claude set up: each click shows its rows, nothing goes back to Claude.
  const customers = page.getByRole('figure', { name: 'Table: Customers by revenue' }).last();
  await customers.scrollIntoViewIfNeeded();
  await customers.getByRole('radio', { name: 'Top 5' }).click();
  await expect(customers.locator('tbody tr')).toHaveCount(5);
  const top = await customers.locator('tbody tr').first().textContent();
  await customers.getByRole('radio', { name: 'Bottom 5' }).click();
  await expect(customers.locator('tbody tr')).toHaveCount(5);
  expect(await customers.locator('tbody tr').first().textContent()).not.toBe(top);
  await customers.getByRole('radio', { name: 'All' }).click();
  await customers.getByRole('switch', { name: 'Overdue only' }).click();
  await expect(customers.locator('tbody tr')).toHaveCount(3);
  await customers.getByRole('switch', { name: 'Overdue only' }).click();
  await customers.getByRole('combobox', { name: 'Region' }).click();
  await page.getByRole('option', { name: 'EU' }).click();
  await expect(customers.locator('tbody tr').first()).toContainText('EU');
  await shot(page, 'views-03b-controls', customers);

  // A plain Markdown table sorts by its headings too.
  const plain = page.getByRole('figure', { name: 'Table' }).filter({ hasText: 'Provider' }).last();
  await plain.getByRole('columnheader', { name: /Success rate/ }).getByRole('button').click();
  await expect(plain.locator('tbody tr').first()).toContainText('Adyen');
  // Long enough to search: the search box sits clear of the sticky headings, its ring whole.
  const search = (await plain.getByRole('searchbox', { name: 'Search the rows' }).locator('..').boundingBox())!;
  const heading = (await plain.locator('thead').boundingBox())!;
  expect(heading.y).toBeGreaterThanOrEqual(search.y + search.height + 4);
  await shot(page, 'views-03c-markdown-table', plain);

  const code = page.getByRole('figure', { name: 'Code' }).last();
  await expect(code).toContainText('src/webhooks.ts');
  await expect(code).toContainText('Not idempotent');

  const colors = page.getByRole('figure', { name: 'Colors: Checkout palette' }).last();
  await colors.scrollIntoViewIfNeeded();
  await expect(colors).toContainText('#2a78d6');
  const palette = page.getByText(/The checkout button uses/).last();
  await expect(palette.getByRole('button', { name: '#2a78d6', exact: true })).toBeVisible();
  await shot(page, 'views-00-inline-colors', palette);
  await colors.getByRole('button', { name: 'Use These Colors' }).click();
  await expect(composer(page)).toHaveValue(/Use these colors: Primary: #2a78d6/);
  await composer(page).fill('');

  if (SHOTS) {
    await stats.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, 'views-05-stats', stats);
    await chart.scrollIntoViewIfNeeded();
    await chart.locator('svg.recharts-surface, .recharts-wrapper svg').first().hover({ position: { x: 300, y: 120 } });
    await shot(page, 'views-06-chart', chart);
    await code.scrollIntoViewIfNeeded();
    await shot(page, 'views-07-code', code);
    await colors.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, 'views-08-colors', colors);
  }
});

test('in the dark too (screenshots only)', async ({ page }) => {
  test.skip(!SHOTS, 'only for VIEW_SHOTS');
  test.setTimeout(150_000);
  await page.goto('/');
  await openWorkspace(page, 'webhook-retries');
  await untilIdle(page);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await composer(page).fill('show me the payments dashboard');
  await composer(page).press('Enter');
  await expect(page.getByRole('figure', { name: 'Colors: Checkout palette' }).last()).toBeVisible();
  await page.waitForTimeout(2500);
  // The conversation stays pinned to its end; the wheel unpins it, a screen at a time.
  await page.mouse.move(650, 450);
  for (let n = 1; n <= 5; n++) {
    await page.mouse.wheel(0, -640);
    await page.waitForTimeout(900);
    await shot(page, `views-dark-${n}`);
  }
});

test('a broken view says what is wrong and shows its JSON', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await openWorkspace(page, 'webhook-retries');
  await untilIdle(page);
  await composer(page).fill('```beluga-chart\n{"title": "Nothing"}\n```');
  await composer(page).press('Enter');
  await expect(page.getByText(/Can’t show this: a chart needs "data" or a "source"/).last()).toBeVisible({ timeout: 10_000 });
});
