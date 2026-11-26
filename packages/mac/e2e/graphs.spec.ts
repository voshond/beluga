import { expect, test, type Page } from './fixtures.js';

/** Graphs Claude draws (docs/graphs.md): /visualize in the demo, then point, click, walk through, open in full. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

async function openWorkspace(page: Page, name: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

/** The demo's Claude may be busy here (a long run, queued messages): wait until it's free. */
async function untilIdle(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 90_000 });
}

test('draws what Claude visualizes, and you can explore it', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await openWorkspace(page, 'webhook-retries');
  await untilIdle(page);
  await composer(page).fill('/visualize how a payment goes through');
  await composer(page).press('Enter');
  // Your words, not the command.
  await expect(page.getByText('Visualize how a payment goes through').last()).toBeVisible();

  const graph = page.getByRole('figure', { name: 'Graph: How a payment goes through' }).last();
  await expect(graph.locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  await expect(graph.getByText('9 parts · 5 steps')).toBeVisible();
  const node = (label: string) => graph.locator('.react-flow__node').filter({ hasText: label });
  await expect(node('Webhook handler')).toBeVisible();
  await expect(node('orders')).toContainText('stripe_intent');

  // A node's details: Claude's notes and what it's connected to; a connection goes there.
  await node('Webhook handler').click();
  const details = graph.getByRole('complementary', { name: 'About Webhook handler' });
  await expect(details).toContainText('idempotent');
  await expect(details).toContainText('Blocked');
  await details.getByRole('button', { name: /Sends data to\s*orders/ }).click();
  await expect(graph.getByRole('complementary', { name: 'About orders' })).toBeVisible();
  await graph.getByRole('complementary', { name: 'About orders' }).getByRole('button', { name: 'Close' }).click();

  // The walkthrough: Next, Back, Esc.
  await graph.hover();
  await graph.getByRole('button', { name: 'Walk Me Through It' }).click();
  const walk = graph.getByRole('region', { name: 'Walkthrough' });
  await expect(walk).toContainText('1 of 5');
  await expect(walk).toContainText('The customer pays');
  await walk.getByRole('button', { name: 'Next' }).click();
  await expect(walk).toContainText('Who is asking?');
  await page.keyboard.press('ArrowLeft');
  await expect(walk).toContainText('1 of 5');
  await page.keyboard.press('Escape');
  await expect(walk).toBeHidden();

  // The whole window, with a minimap; Esc closes it.
  await graph.hover();
  await graph.getByRole('button', { name: 'Open in Full Window' }).click();
  const full = page.getByRole('dialog', { name: 'How a payment goes through' });
  await expect(full.locator('[data-ready="true"]')).toBeVisible();
  await expect(full.locator('.react-flow__minimap')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(full).toBeHidden();

  // Its picture: the whole graph on its background, drawn in this window (a browser downloads it).
  await graph.click({ button: 'right', position: { x: 12, y: 12 } });
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Save as Image…' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('How a payment goes through.png');
  const png = await saved.createReadStream().then(async (stream) => Buffer.concat(await stream.toArray()));
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  if (process.env.GRAPH_PICTURE_TO) await saved.saveAs(process.env.GRAPH_PICTURE_TO);
  await expect(page.locator('.react-flow__viewport')).toHaveCount(1);

  // Its picture waits in the message box to go to a Jira ticket: nothing is sent until you send it.
  await graph.click({ button: 'right', position: { x: 12, y: 12 } });
  await page.getByRole('menuitem', { name: 'Attach to Jira Ticket…' }).click();
  await expect(composer(page)).toHaveValue(/^\[[^\]]+\] Attach this picture of “How a payment goes through” to the Jira ticket $/);
  await composer(page).fill('');

  // Kept in an initiative, where it's drawn live.
  await graph.click({ button: 'right', position: { x: 12, y: 12 } });
  await page.getByRole('menuitem', { name: 'Keep in Initiative' }).hover();
  await page.getByRole('menuitem', { name: 'Checkout v2' }).click();
  await expect(page.getByText('Kept “How a payment goes through” in Checkout v2')).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'All Initiatives' }).click();
  await page.getByRole('button', { name: 'Open Checkout v2' }).click();
  await page.getByRole('tab', { name: /Artifacts/ }).click();
  await page.getByRole('listitem', { name: /How a payment goes through/ }).click();
  const kept = page.getByRole('dialog').getByRole('figure', { name: 'Graph: How a payment goes through' });
  await expect(kept.locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
});

test('a broken graph says what is wrong and shows its JSON', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await openWorkspace(page, 'webhook-retries');
  await untilIdle(page);
  // Your own message is Markdown too: a block with a mistake in it.
  await composer(page).fill('```beluga-graph\n{"nodes": [{"id": "a"}]}\n```');
  await composer(page).press('Enter');
  await expect(page.getByText(/Can’t draw this graph: nodes\[0\]\.label/).last()).toBeVisible({ timeout: 10_000 });
});
