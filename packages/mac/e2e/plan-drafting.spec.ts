import { expect, test, type Locator, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/**
 * A plan while Claude writes it (KLD-28): a name that isn't your message, one placeholder inside
 * the canvas with one status line, no run-mode control yet, a readable conversation at 380px,
 * and the Inspector showing the plan. The demo Claude drafts in about a second at the tests' pace,
 * so this runs with a slower one: E2E_DEMO_PACE=6 npx playwright test e2e/plan-drafting.spec.ts
 * (SHOTS=dir also saves light and dark screenshots there).
 */

test.skip(!process.env.E2E_DEMO_PACE, 'Needs a slower demo Claude (E2E_DEMO_PACE=6) to see the plan being written');

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

const GOAL = [
  'A couple of things that we should improve because they look unfinished while Claude writes a plan.',
  'The title is the first message cut off, the skeleton cards float over the sidebar, there are four different statuses at once, and the run mode control is front and centre while nothing can run yet.',
  'The conversation opens on a wall of text and its step rows overflow the right edge of the pane.',
  'Make it calm: one status, a tidy placeholder, and a real title.',
].join('\n\n');

/** Every element inside `box` ends at or before its right edge (nothing spills out of the pane). */
async function overflowRight(box: Locator): Promise<string[]> {
  return box.evaluate((root) => {
    const edge = root.getBoundingClientRect().right + 0.5;
    return [...root.querySelectorAll('*')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        // Inside something that scrolls or clips sideways: it's hidden, not spilling.
        for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
          const ox = getComputedStyle(p).overflowX;
          if (ox !== 'visible' && p.getBoundingClientRect().right <= edge) return false;
        }
        return r.right > edge;
      })
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} → ${(el.textContent ?? '').slice(0, 30)}`);
  });
}

test('a plan being written: calm, clipped, one status (KLD-28)', async ({ page }) => {
  // The conversation pane is clamp(320px, 30vw, 420px): 380px wide at this window width.
  await page.setViewportSize({ width: 1267, height: 820 });
  await page.goto('/');
  await openWork(page, 'Plans');
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await page.getByRole('button', { name: 'New Plan', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  await sheet.getByLabel('Goal').fill(GOAL);
  await sheet.getByRole('button', { name: 'Plan with Your Agent' }).click();

  // One line says what's going on, under one placeholder.
  const line = main(page).getByRole('status').filter({ hasText: /Your agent is reading bob-api and writing the plan · \d+s/ });
  await expect(line).toBeVisible({ timeout: 20_000 });
  const name = page.getByRole('textbox', { name: 'Plan name' });
  // Never your message: "New plan", then a short name from a quick model.
  await expect(name).not.toHaveValue(/A couple of things that we should improve because/);
  // The demo Claude's quick namer, like Haiku: what it's about in a few words, not the first ones.
  await expect(name).toHaveValue('Improve unfinished title');
  expect((await name.inputValue()).split(' ').length).toBeLessThanOrEqual(6);
  await expect(name).not.toHaveValue(/^A couple of/);
  await expect(sidebar(page)).not.toContainText('A couple of things that we should');

  // No Draft pill, no "working" in the conversation's header, no run-mode control, no view toggle yet.
  await expect(main(page).getByText('Draft', { exact: true })).toHaveCount(0);
  await expect(main(page).getByText('Your agent is writing the plan…')).toHaveCount(0);
  const chat = page.getByRole('complementary', { name: 'Conversation' });
  await expect(chat.locator('header')).not.toContainText('working');
  await expect(chat.getByText(/^Working · \d/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Runs on / })).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Runs' })).toHaveCount(0);
  await expect(main(page).getByRole('tablist', { name: 'Show' })).toHaveCount(0);

  // The placeholder sits inside the canvas: nothing over the sidebar or the conversation.
  const stage = await main(page).locator('[class*="stage"]').first().boundingBox();
  const sk = await main(page).locator('[class*="skeleton"]').boundingBox();
  expect(sk!.x).toBeGreaterThanOrEqual(stage!.x);
  expect(sk!.x + sk!.width).toBeLessThanOrEqual(stage!.x + stage!.width);
  expect(await main(page).locator('[class*="skMilestone"]').count()).toBe(3);

  // The conversation: 380px, your long message folded to three lines, nothing past its right edge.
  expect(Math.round((await chat.boundingBox())!.width)).toBe(380);
  await expect(chat.getByRole('button', { name: 'Show all' })).toBeVisible({ timeout: 10_000 });
  const mine = chat.locator('[data-mine="true"]').first();
  expect((await mine.boundingBox())!.height).toBeLessThan(140);
  await expect(chat.getByText(/Read src\/server\.ts|Glob src/).first()).toBeVisible({ timeout: 15_000 });
  expect(await overflowRight(chat)).toEqual([]);

  // No right panel beside a plan (KLD-54): its project is in the toolbar, and the panel's button isn't there.
  await expect(page.locator('aside[aria-label="Panel"]')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('button', { name: /^(Show|Hide) the panel/ })).toHaveCount(0);
  await expect(page.locator('header').filter({ hasText: 'bob-api' }).first()).toBeVisible();

  const dir = process.env.SHOTS;
  if (dir) {
    await line.waitFor();
    await page.screenshot({ path: `${dir}/kld-28-drafting-light.png` });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    // Screenshots only: the theme's colors fade over; let them land.
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${dir}/kld-28-drafting-dark.png` });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  }

  // Written: the run mode comes back as the header's mode button (“Runs on …”, KLD-22), and the view toggle is labelled.
  await expect(page.getByRole('button', { name: 'Approve Plan' })).toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('button', { name: /^Runs on / })).toBeVisible();
  const show = main(page).getByRole('tablist', { name: 'Show' });
  await expect(show.getByRole('tab')).toHaveText(['Canvas', 'List']);
  await expect(line).toHaveCount(0);
  // The canvas lays the written plan out: never left on "Laying out…" (KLD-36).
  const canvas = main(page).locator('[data-ready]');
  await expect(canvas).toHaveAttribute('data-ready', 'true', { timeout: 10_000 });
  await expect(main(page).getByText('Laying out…')).toHaveCount(0);
  await expect(canvas.locator('.react-flow__node-milestone')).toHaveCount(3);
  await expect(canvas.locator('.react-flow__node-task').first()).toBeVisible();
  if (dir) await page.screenshot({ path: `${dir}/kld-28-written-light.png` });
  // Show all opens your whole message.
  await chat.getByRole('button', { name: 'Show all' }).click();
  await expect(chat.getByRole('button', { name: 'Show less' })).toBeVisible();
});
