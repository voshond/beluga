import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';
import { openWork } from './helpers.js';

/** Clarify-first planning (BLG-8): a plan's decisions in its details pane, and approving that waits on an open question. */

const main = (page: Page) => page.locator('main');

async function openPlans(page: Page): Promise<void> {
  await page.goto('/');
  await openWork(page, 'Plans');
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await expect(page.getByRole('button', { name: 'Project: bob-api' })).toBeVisible();
}
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.BELUGA_SHOTS) return;
  // The details pane slides in: shot once it has.
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(process.env.BELUGA_SHOTS, name) });
};

test.describe.configure({ mode: 'serial' });

test('the demo’s plan lists what was decided while planning, yours and the defaults', async ({ page }) => {
  await openPlans(page);
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Decisions · 4' }).click();
  const pane = page.getByRole('complementary', { name: 'Decided while planning' });
  await expect(pane).toContainText('2 are defaults your agent chose without asking');
  const hosted = pane.getByRole('listitem').filter({ hasText: 'Hosted Stripe Checkout, or the embedded Payment Element?' });
  await expect(hosted).toContainText('Hosted Checkout');
  await expect(hosted).toContainText('You');
  await expect(pane.getByRole('listitem').filter({ hasText: 'How long are handled webhook ids kept?' })).toContainText('Default');
  await shot(page, '01-decisions-pane.png');
});

test('a plan with an open question waits for the answer; answered, it approves', async ({ page }) => {
  await openPlans(page);
  await page.getByRole('button', { name: 'New Plan', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /^Plan in / });
  await sheet.getByLabel('Goal').fill('Send invoices from the admin, ask me what you need');
  await sheet.getByRole('button', { name: 'Plan with Your Agent' }).click();
  // Written with a question left open: the main button asks for the answer, and a bar says what's open.
  const answer = page.getByRole('button', { name: 'Answer the Open Question', exact: true });
  await expect(answer).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Approve Plan' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'A question is still open' })).toBeVisible();
  await expect(main(page).getByText('Answer the open question in the conversation, then approve the plan')).toBeVisible();
  await answer.click();
  const pane = page.getByRole('complementary', { name: 'Decided while planning' });
  await expect(pane.getByRole('region', { name: 'Still open' })).toContainText('Who signs off on the release before it goes out?');
  await expect(pane.getByRole('region', { name: 'Decided' })).toContainText('The existing Postgres, via src/db.ts');
  await shot(page, '02-open-question.png');
  // Answered in the conversation: it's yours on the plan, and the plan can be approved.
  const chat = page.getByRole('complementary', { name: 'Conversation' });
  await chat.getByRole('textbox', { name: 'Message your agent about the plan' }).fill('Mia signs off');
  await chat.getByRole('textbox', { name: 'Message your agent about the plan' }).press('Enter');
  const approve = page.getByRole('button', { name: 'Approve Plan' }).first();
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('status').filter({ hasText: 'A question is still open' })).toHaveCount(0);
  await expect(pane.getByRole('listitem').filter({ hasText: 'Who signs off on the release before it goes out?' })).toContainText('Mia signs off');
  await shot(page, '03-answered.png');
  await approve.click();
  await expect(page.getByRole('button', { name: 'Approve Plan' })).toHaveCount(0);
});
