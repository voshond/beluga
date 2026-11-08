import { expect, test, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/**
 * Verify, Then Approve (BLG-772): never automatic, picked from Approve Plan's ▾ with the agent (and
 * model) that verifies the plan and then works it. A fresh agent reads the draft; what it finds shows
 * on the plan, with Fix and Approve Anyway. The demo's agent finds one thing to fix (src/agent/mock.ts).
 */

const main = (page: Page) => page.locator('main');
const shot = (name: string): string => `../../.beluga/scratch/${name}`;

test('Verify, Then Approve: picked with its agent, it reads the draft and shows what to fix', async ({ page }) => {
  await page.goto('/');
  await openWork(page, 'Plans');
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await page.getByRole('button', { name: 'New Plan', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  await sheet.getByLabel('Goal').fill('Export orders as CSV for accounting');
  await sheet.getByRole('button', { name: 'Plan with Your Agent' }).click();
  await expect(page.getByRole('button', { name: 'Approve Plan' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(main(page).locator('[data-ready]')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  const chat = page.getByRole('complementary', { name: 'Conversation' });
  await chat.getByRole('textbox', { name: 'Message your agent about the plan' }).fill('rate limits on the export endpoint');
  await chat.getByRole('textbox', { name: 'Message your agent about the plan' }).press('Enter');
  await expect(main(page).locator('.react-flow__node').filter({ hasText: /Rate limits on the export endpoint/i })).toBeVisible({ timeout: 20_000 });
  // Nothing runs by itself: the plan just waits for Approve.
  await expect(page.getByText('Verifying the plan')).toHaveCount(0);

  // Approve Plan's ▾: Verify, Then Approve ▸ the same agents and models as Approve, worked by.
  await page.getByRole('button', { name: 'More ways to approve' }).first().click();
  const verify = page.getByRole('menuitem', { name: 'Verify, Then Approve' });
  await expect(verify).toBeVisible();
  await page.screenshot({ path: shot('verify-01-menu.png') });
  // Its submenu, from the keyboard (the pointer crossing other rows would close it): Claude · Sonnet.
  await verify.focus();
  await page.keyboard.press('ArrowRight');
  const agents = page.getByRole('menu', { name: 'Verify, Then Approve' });
  const sonnet = agents.getByRole('menuitem', { name: 'Claude · Sonnet' });
  await expect(sonnet).toBeVisible();
  await sonnet.focus();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot('verify-02-agents.png') });
  await sonnet.dispatchEvent('click');

  // While it reads: the button and a line say so.
  const verifying = page.getByRole('status', { name: 'Verifying the plan' });
  await expect(verifying).toBeVisible({ timeout: 10_000 });
  // Never a still line: its checks light up one by one, its latest words show, and Watch It Work opens its conversation.
  await expect(verifying.locator('[data-state="now"]')).toHaveText(/Contradictions|Duplicates|Stale decisions|Order/, { timeout: 10_000 });
  await expect(verifying).toContainText(/(Contradictions|Duplicates|Stale|Order): /);
  await expect(verifying.getByRole('button', { name: 'Watch It Work' })).toBeVisible();
  await page.screenshot({ path: shot('verify-03-verifying.png') });
  await verifying.screenshot({ path: shot('verify-03b-panel.png') });
  // Frames of the panel while it works (for a GIF of the motion; BELUGA_VERIFY_FRAMES=1 only).
  if (process.env.BELUGA_VERIFY_FRAMES) {
    for (let i = 0; i < 80 && (await verifying.isVisible()); i++) {
      await verifying.screenshot({ path: shot(`verify-frames/f${String(i).padStart(3, '0')}.png`), animations: 'allow' }).catch(() => undefined);
      await page.waitForTimeout(60);
    }
  }

  // What it found, with Fix and Approve Anyway; nothing is approved.
  await expect(page.getByText(/Verifying found one thing to fix/)).toBeVisible({ timeout: 30_000 });
  await expect(main(page).getByRole('button', { name: 'Approve Anyway' }).first()).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Fix', exact: true }).first()).toBeVisible();
  await page.screenshot({ path: shot('verify-04-findings.png') });
});
