import { expect, test, type Page } from './fixtures.js';

/**
 * What Claude is doing stays at the bottom of the chat (BLG-22): a message you steer into a turn
 * lands below where the turn began, and the turn's live part (the step it's on, the working line,
 * then its answer) goes on below it. When it answers, both parts stay where they were drawn.
 * The demo's "walk the codebase" Claude takes what you say mid-turn in, as Claude Code does.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const OUT = '../../.beluga/scratch/blg-22';

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
      .map((el) => ({ i: Number(el.getAttribute('data-index')), part: el.querySelector('[data-turn-part]')?.getAttribute('data-turn-part') ?? '', text: (el as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 80) }))
      .sort((a, b) => a.i - b.i),
  );

/**
 * Watches every frame (after it's laid out) for rows of the chat drawn over one another, and for
 * a sent message's flying copy.
 */
async function watchFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { seen: { overlaps: string[]; flights: number } };
    w.seen = { overlaps: [], flights: 0 };
    const look = () => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-index]')]
        .map((el) => ({ i: Number(el.dataset.index), r: el.getBoundingClientRect() }))
        .sort((a, b) => a.i - b.i);
      for (let k = 1; k < rows.length; k++) {
        const over = rows[k - 1]!.r.bottom - rows[k]!.r.top;
        if (over > 1) w.seen.overlaps.push(`${rows[k - 1]!.i}/${rows[k]!.i} by ${Math.round(over)}px`);
      }
      w.seen.flights += document.querySelectorAll('[data-send-flight]').length;
      requestAnimationFrame(() => setTimeout(look));
    };
    requestAnimationFrame(() => setTimeout(look));
  });
}
const frames = (page: Page) => page.evaluate(() => (window as unknown as { seen: { overlaps: string[]; flights: number } }).seen);

test('a message steered in mid-turn lands above Claude’s live part, which stays the last thing in the chat; answered, nothing moves', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await openWorkspace(page, 'new-hero', 'landing');
  await composer(page).fill('walk the codebase and tell me what is risky');
  await composer(page).press('Enter');

  // One working line, at the bottom of the card: what it's doing and for how long. No status in the header, no rail.
  const working = page.locator('[data-working]');
  await expect(working).toHaveCount(1);
  await expect(working).toHaveText(/^Working( · \w.*)?\d+s$/);
  await expect(page.getByText(/^Working · \d/)).toHaveCount(0);
  const card = page.locator('[data-turn]').last();
  expect(await card.locator('[class*="body"]').first().evaluate((el) => getComputedStyle(el, '::before').content)).toBe('none');
  await expect(page.getByRole('progressbar', { name: 'Claude is working' })).toHaveCount(0);
  await expect(card.locator('[data-step]').nth(1)).toBeVisible({ timeout: 15_000 });

  // Steered in (⌥↩): it goes into the turn; the turn's live part moves below it.
  await watchFrames(page);
  await composer(page).fill('also look at the retry logic');
  await composer(page).press('Alt+Enter');
  const tail = page.locator('[data-turn-part="tail"]');
  const head = page.locator('[data-turn-part="head"]');
  await expect(tail).toHaveCount(1);
  await expect(head).toHaveCount(1);
  await expect(head).toContainText('Still working · continues below');
  await expect(tail.locator('[data-working]')).toBeVisible();
  let rows = await rowsInOrder(page);
  expect(rows.at(-1)?.part).toBe('tail');
  const steered = rows.findIndex((r) => r.text.includes('also look at the retry logic'));
  expect(steered).toBeGreaterThan(rows.findIndex((r) => r.part === 'head'));
  // The head keeps what was done before you spoke; what Claude does now is below.
  await expect(tail.locator('[data-current="true"]')).toHaveCount(1, { timeout: 5000 });
  await expect(head.locator('[data-current="true"]')).toHaveCount(0);
  // The moment it split was clean: no row drawn over another, and no copy of the message flying over the live part.
  await page.waitForTimeout(600);
  expect(await frames(page)).toEqual({ overlaps: [], flights: 0 });
  await page.screenshot({ path: `${OUT}/01-steered-live-at-bottom.png` });

  // Again: still below the newest message.
  await composer(page).fill('and the session code too');
  await composer(page).press('Alt+Enter');
  await expect(page.locator('[data-index]', { hasText: 'and the session code too' })).toBeVisible();
  rows = await rowsInOrder(page);
  expect(rows.at(-1)?.part).toBe('tail');
  expect(rows.findIndex((r) => r.text.includes('and the session code too'))).toBeLessThan(rows.length - 1);
  // The chat is at its bottom: the working line is in sight.
  await expect(tail.locator('[data-working]')).toBeInViewport();
  await expect(page.locator('[data-send-flight]')).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${OUT}/02-steered-live-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });

  // Answered: the working line goes, the answer is where the live part was, the head stays in place.
  await expect(page.locator('[data-turn="done"][data-turn-part="tail"]')).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('[data-working]')).toHaveCount(0);
  await expect(head).toHaveCount(1);
  await expect(head).toContainText('Continued below');
  rows = await rowsInOrder(page);
  expect(rows.at(-1)?.part).toBe('tail');
  await expect(tail).toContainText('Walked the codebase');
  expect(rows.findIndex((r) => r.part === 'head')).toBeLessThan(steered + 1);
  // Show Steps on the answer opens the steps of both parts.
  await tail.hover();
  await tail.getByRole('button', { name: 'Show Steps' }).click();
  await expect(head.getByRole('list', { name: "The agent's steps" })).toBeVisible();
  await expect(tail.getByRole('list', { name: "The agent's steps" })).toBeVisible();
  // (Past the steps opening.)
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/03-answered-stays-in-place.png` });
});

test('a queued message steered from the tray: its note sits above the live part, and says the answer is below', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await openWorkspace(page, 'new-hero', 'landing');
  await composer(page).fill('walk the codebase once more');
  await composer(page).press('Enter');
  await expect(page.locator('[data-working]')).toHaveCount(1);
  await composer(page).fill('check the tests while you are at it');
  await composer(page).press('Enter');
  const tray = page.getByRole('region', { name: 'Queued messages' });
  const queued = tray.getByRole('listitem', { hasText: 'check the tests while you are at it' });
  await queued.hover();
  await queued.getByRole('button', { name: 'Steer' }).click();
  await expect(tray).toBeHidden();
  const tail = page.locator('[data-turn-part="tail"]');
  await expect(tail.locator('[data-working]')).toBeVisible();
  // Sent, not read yet: said on the message itself (BLG-54), till Claude's next step; then it reads as any message.
  const message = page.locator('[data-index]', { hasText: 'check the tests while you are at it' }).first();
  await expect(message.locator('[data-steer-waiting]')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('The agent read this while it worked; the answer below covers it.')).toHaveCount(0);
  const rows = await rowsInOrder(page);
  expect(rows.at(-1)?.part).toBe('tail');
  // Only the live part says it's working: the note doesn't.
  await expect(page.locator('[data-working]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Stop Claude' }).first().click();
});
