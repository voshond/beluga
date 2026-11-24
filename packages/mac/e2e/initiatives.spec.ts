import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const shots = process.env.INITIATIVE_SHOTS;
const shot = async (page: Page, name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: path.join(shots, name) });
};

const openInitiative = async (page: Page, name: string): Promise<void> => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: /Initiatives/ }).first().click();
  await page.getByRole('button', { name: `Open ${name}` }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
};

test('an initiative’s page shows the epic’s tickets, open first, with their pull requests', async ({ page }) => {
  await openInitiative(page, 'Checkout v2');
  const tickets = page.getByRole('region', { name: 'Tickets' });
  await expect(tickets.getByRole('row')).toHaveCount(5);
  await expect(tickets.locator('tbody tr').first()).toHaveAttribute('data-category', 'inProgress');
  await expect(tickets.locator('tbody tr').last()).toHaveAttribute('data-ticket', 'SHOP-133');
  await expect(tickets.getByRole('button', { name: 'Open SHOP-150 in Jira' })).toBeVisible();
  await expect(tickets.getByRole('button', { name: /Open pull request #412 in example\/shop: Open/ })).toBeVisible();
  await expect(tickets.getByRole('button', { name: /Open pull request #398 in example\/shop: Merged/ })).toBeVisible();
  await expect(tickets.getByText(/4 tickets · 1 done · 1 open pull request/)).toBeVisible();
  await expect(tickets.getByRole('button', { name: 'Refresh the tickets from Jira' })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Goal' }).getByRole('heading', { name: 'Scope' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Slack conversations' }).getByRole('button', { name: 'Open 3DS on Safari in Slack' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Meetings' }).getByText('Thursday')).toBeVisible();
  await shot(page, '01-initiative-page.png');
  await expect(tickets.getByRole('columnheader', { name: 'Assignee' })).toHaveCount(0);
  await page.setViewportSize({ width: 2300, height: 1000 });
  await expect(tickets.getByRole('columnheader', { name: 'Assignee' })).toBeVisible();
  await expect(tickets.getByRole('cell', { name: 'Ana Ruiz', exact: true })).toBeVisible();
  await shot(page, '01b-initiative-page-wide.png');
});

test('several epics group the tickets by epic', async ({ page }) => {
  await openInitiative(page, 'Mobile Onboarding');
  const tickets = page.getByRole('region', { name: 'Tickets' });
  await expect(tickets.locator('[data-epic]')).toHaveCount(2);
  await expect(tickets.locator('[data-epic="APP-88"] tbody tr')).toHaveCount(2);
  await expect(tickets.getByRole('button', { name: /pull request #77 in example\/app: Draft/ })).toBeVisible();
  await shot(page, '02-two-epics.png');
});

test('Refine With Agent drafts the goal on the page, and saves it only when taken', async ({ page }) => {
  await openInitiative(page, 'Mobile Onboarding');
  const goal = page.getByRole('region', { name: 'Goal' });
  await goal.getByRole('button', { name: 'Refine the goal with your agent' }).click();
  await expect(goal.getByRole('status')).toContainText('drafting a goal');
  const draft = goal.getByLabel('The agent’s draft of the goal');
  await expect(draft.getByRole('heading', { name: 'Open questions' })).toBeVisible();
  await shot(page, '03-refine-draft.png');
  await draft.getByRole('button', { name: 'Keep Mine' }).click();
  await expect(goal.getByRole('heading', { name: 'Acceptance' })).toHaveCount(0);
  await goal.getByRole('button', { name: 'Refine the goal with your agent' }).click();
  await goal.getByLabel('The agent’s draft of the goal').getByRole('button', { name: 'Use This' }).click();
  await expect(goal.getByRole('heading', { name: 'Acceptance' })).toBeVisible();
  await expect(goal.getByLabel('The agent’s draft of the goal')).toHaveCount(0);
});

test('Edit lists Slack conversations and meetings row by row, and Refine fills the goal', async ({ page }) => {
  await openInitiative(page, 'Checkout v2');
  await page.getByRole('button', { name: 'Edit…' }).click();
  const sheet = page.getByRole('dialog');
  const slack = sheet.getByRole('group', { name: 'Slack conversation' });
  await expect(slack.locator('[data-ref-row]')).toHaveCount(2);
  await expect(slack.getByLabel('Label for slack conversation 2')).toHaveValue('3DS on Safari');
  await slack.getByRole('button', { name: 'Add Conversation' }).click();
  const third = slack.getByLabel('Slack conversation 3', { exact: true });
  await third.focus();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text', 'https://example.slack.com/archives/C0PAY/p1763990000000200\nhttps://example.slack.com/archives/D0ANA');
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(slack.locator('[data-ref-row]')).toHaveCount(4);
  await slack.getByLabel('Label for slack conversation 3').fill('Payments thread');
  await slack.getByRole('button', { name: 'Remove #checkout-v2' }).click();
  await expect(slack.locator('[data-ref-row]')).toHaveCount(3);
  const meetings = sheet.getByRole('group', { name: 'Meeting' });
  await meetings.getByRole('button', { name: 'Add Meeting' }).click();
  await meetings.getByLabel('Meeting 3', { exact: true }).fill('https://calendar.google.com/calendar/event?eid=abc');
  await sheet.getByRole('button', { name: 'Refine the goal with your agent' }).click();
  await sheet.getByLabel('The agent’s draft of the goal').getByRole('button', { name: 'Use This' }).click();
  await expect(sheet.getByRole('textbox', { name: 'Goal' })).toHaveValue(/## Open questions/);
  await shot(page, '04-edit-sheet.png');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  const follows = page.getByRole('region', { name: 'Slack conversations' });
  await expect(follows.getByRole('listitem')).toHaveCount(3);
  await expect(follows.getByRole('button', { name: 'Open Payments thread in Slack' })).toBeVisible();
  await expect(follows.getByText('#checkout-v2')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Meetings' }).getByRole('listitem')).toHaveCount(3);
  await expect(page.getByRole('region', { name: 'Goal' }).getByRole('heading', { name: 'Open questions' })).toBeVisible();
  await shot(page, '05-after-save.png');
});
