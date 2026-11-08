import { expect, test, type Page } from './fixtures.js';

/**
 * A message you steer in while Claude is on a long step (BLG-54): it shows as sent but not read
 * until Claude reads it, Claude's live activity (the step it's on, the one working line) stays
 * below it at the very bottom, and Send now stops the step so Claude goes on from your message.
 * The demo's "full test suite" Claude has a step that runs long.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const OUT = process.env.BLG54_OUT ?? '../../.beluga/scratch/blg-54';

async function openWorkspace(page: Page, name: string, project: string): Promise<void> {
  const row = sidebar(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: project }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name, exact: true }).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

/** The chat's rows in order (the virtualized list's indexes): what each is. */
const rowsInOrder = (page: Page) =>
  page.locator('[data-index]').evaluateAll((els) =>
    els
      .map((el) => ({ i: Number(el.getAttribute('data-index')), working: Boolean(el.querySelector('[data-working]')), text: (el as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 400) }))
      .sort((a, b) => a.i - b.i),
  );

test('a steered message is sent, not read, until Claude reads it; Send now stops the long step and Claude goes on from it', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await openWorkspace(page, 'new-hero', 'landing');
  await composer(page).fill('run the full test suite');
  await composer(page).press('Enter');
  // On its long step.
  await expect(page.locator('[data-current="true"]', { hasText: /test:all/ })).toBeVisible({ timeout: 15_000 });

  await composer(page).fill('look at the webhook retries first');
  await composer(page).press('Alt+Enter');
  const message = page.locator('[data-index]', { hasText: 'look at the webhook retries first' }).first();
  const waiting = message.locator('[data-steer-waiting="next_step"]');
  await expect(waiting).toContainText('Sent · Claude reads it after its current step');
  // No note card of its own. Unread, it waits below the working turn (BLG-47): the last row, the one working line just above it.
  await expect(page.getByText('Your agent reads this after its current step')).toHaveCount(0);
  await expect(page.locator('[data-working]')).toHaveCount(1);
  await expect.poll(async () => {
    const rows = await rowsInOrder(page);
    return Boolean(rows.at(-1)?.text.includes('look at the webhook retries first') && rows.at(-2)?.working);
  }).toBe(true);
  // The box says how to send it now.
  await expect(page.locator('[class*="legend"]')).toContainText('⌥⇧↩ send now');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/54-steer-pending.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${OUT}/54-steer-pending-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });

  // Send now: the step stops, Claude reads it in a turn of its own, below it; still one working line, last.
  await message.getByRole('button', { name: 'Send now' }).click();
  await expect(message.locator('[data-steer-waiting]')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Interrupted to read your message')).toBeVisible();
  await expect(page.locator('[data-working]')).toHaveCount(1);
  // Read, your message moves to where Claude read it (BLG-47): right after the interruption, with what Claude does since below it.
  const readAfterStop = (r: Array<{ text: string }>) => r.findIndex((x) => x.text.includes('Interrupted to read your message')) < r.findIndex((x) => x.text.includes('look at the webhook retries first'));
  await expect.poll(async () => {
    const rows = await rowsInOrder(page);
    return readAfterStop(rows) && Boolean(rows.at(-1)?.working);
  }).toBe(true);
  await page.screenshot({ path: `${OUT}/54-steer-read.png` });
  await expect(page.getByText(/Stopped the tests to look at that first/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-working]')).toHaveCount(0);
  await expect.poll(async () => {
    const rows = await rowsInOrder(page);
    return readAfterStop(rows) && Boolean(rows.at(-1)?.text.includes('Stopped the tests to look at that first'));
  }).toBe(true);
  await page.screenshot({ path: `${OUT}/54-steer-answered.png` });
});

test('a second steer joins the first without stopping the step; Cancel takes one back into the box', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await openWorkspace(page, 'new-hero', 'landing');
  await composer(page).fill('run the full test suite once more');
  await composer(page).press('Enter');
  await expect(page.locator('[data-current="true"]', { hasText: /test:all/ })).toBeVisible({ timeout: 15_000 });
  // An earlier test may have left an interrupted turn here: none more may come.
  const interrupted = await page.getByText(/Interrupted/).count();
  await composer(page).fill('use pnpm');
  await composer(page).press('Alt+Enter');
  await composer(page).fill('and skip the e2e part');
  await composer(page).press('Alt+Enter');
  const first = page.locator('[data-index]', { hasText: 'use pnpm' }).first();
  const second = page.locator('[data-index]', { hasText: 'and skip the e2e part' }).first();
  // Both wait for the next step; the step goes on, nothing was stopped.
  await expect(first.locator('[data-steer-waiting="next_step"]')).toBeVisible();
  await expect(second.locator('[data-steer-waiting="next_step"]')).toBeVisible();
  await expect(page.getByText(/Interrupted/)).toHaveCount(interrupted);
  await expect(page.locator('[data-current="true"]', { hasText: /test:all/ })).toBeVisible();
  await page.screenshot({ path: `${OUT}/steer-two-waiting.png` });

  // Cancel the second: it leaves the chat, its words are back in the box; the first still waits.
  await composer(page).fill('');
  await second.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('[data-index]', { hasText: 'and skip the e2e part' })).toHaveCount(0, { timeout: 5_000 });
  await expect(composer(page)).toHaveValue('and skip the e2e part');
  await expect(first.locator('[data-steer-waiting="next_step"]')).toBeVisible();
  await page.screenshot({ path: `${OUT}/steer-cancelled.png` });
  // The step ends on its own: the first is read then, and the turn finishes.
  await expect(first.locator('[data-steer-waiting]')).toHaveCount(0, { timeout: 45_000 });
  await expect(page.locator('[data-working]')).toHaveCount(0, { timeout: 45_000 });
  await composer(page).fill('');
});

test('⇧⌥↩ sends the newest steered message now', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await openWorkspace(page, 'new-hero', 'landing');
  await composer(page).fill('run the full test suite again');
  await composer(page).press('Enter');
  await expect(page.locator('[data-current="true"]', { hasText: /test:all/ })).toBeVisible({ timeout: 15_000 });
  // An earlier test in this chat may have its own answer like this one: one more must come.
  const answers = page.getByText(/Stopped the tests to look at that first/);
  const before = await answers.count();
  await composer(page).fill('skip the e2e part');
  await composer(page).press('Alt+Enter');
  const message = page.locator('[data-index]', { hasText: 'skip the e2e part' }).first();
  await expect(message.locator('[data-steer-waiting]')).toBeVisible();
  await composer(page).press('Shift+Alt+Enter');
  await expect(message.locator('[data-steer-waiting]')).toHaveCount(0, { timeout: 10_000 });
  await expect(answers).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(answers.last()).toBeVisible();
});
