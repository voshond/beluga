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
  const topLevel = tickets.locator('[role="listitem"][data-sub-task="false"]');
  await expect(topLevel).toHaveCount(4);
  await expect(tickets.locator('[data-sub-task="true"]')).toHaveCount(2);
  await expect(topLevel.first()).toHaveAttribute('data-category', 'inProgress');
  await expect(topLevel.last()).toHaveAttribute('data-ticket', 'SHOP-133');
  await expect(tickets.getByRole('button', { name: 'Open SHOP-150 in Jira: 3DS challenge fails on Safari' })).toBeVisible();
  await expect(tickets.locator('[data-ticket="SHOP-141"]')).toContainText('Ana Ruiz');
  await expect(tickets.locator('[data-ticket="SHOP-141"]')).toContainText('Blocked');
  await expect(tickets.getByRole('button', { name: /Open pull request #412 in example\/shop: Open/ })).toBeVisible();
  await expect(tickets.getByRole('button', { name: /Open pull request #398 in example\/shop: Merged/ })).toBeVisible();
  await expect(tickets.getByText(/4 tickets · 1 done · 2 sub-tasks, 1 done · 1 open pull request/)).toBeVisible();
  await expect(tickets.getByRole('button', { name: 'Refresh the tickets from Jira' })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Goal' }).getByRole('heading', { name: 'Scope' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Slack conversations' }).getByRole('button', { name: 'Open 3DS on Safari in Slack' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Meetings' }).getByText('Thursday')).toBeVisible();
  const docs = page.getByRole('region', { name: 'Docs' });
  await expect(docs.getByRole('button', { name: 'Open Checkout v2 spec in the browser' })).toBeVisible();
  await expect(docs.getByText('Confluence', { exact: true })).toBeVisible();
  await expect(docs.getByText('Google Sheet', { exact: true })).toBeVisible();
  await docs.scrollIntoViewIfNeeded();
  await shot(page, '01c-initiative-docs.png');
  await shot(page, '01-initiative-page.png');
  if (shots) {
    await page.emulateMedia({ colorScheme: 'dark' });
    await tickets.screenshot({ path: path.join(shots, '06-tickets-dark.png') });
    await page.getByRole('progressbar').first().locator('..').screenshot({ path: path.join(shots, '07-bar-dark.png') });
  }
  const bar = page.getByRole('progressbar').first();
  expect((await bar.locator('[data-part="done"]').boundingBox())!.width).toBeGreaterThan(100);
  expect((await bar.locator('[data-part="inProgress"]').boundingBox())!.width).toBeGreaterThan(30);
  await page.setViewportSize({ width: 2300, height: 1000 });
  await expect(tickets.locator('[data-ticket="SHOP-141"]').getByText(/Ana Ruiz/).first()).toBeVisible();
  await shot(page, '01b-initiative-page-wide.png');
  if (shots) await tickets.screenshot({ path: path.join(shots, '08-tickets-dark-wide.png') });
});

test('the Suggestions section lists decisions.md’s open questions and adds its settled notes to the decision log', async ({ page }) => {
  await openInitiative(page, 'Checkout v2');
  const section = page.getByRole('region', { name: 'Suggestions' });
  await expect(section.getByText('Waiting on others · 2')).toBeVisible();
  const open = section.getByRole('list', { name: 'Open questions' });
  await expect(open.getByRole('listitem')).toHaveCount(2);
  await expect(open.getByRole('listitem').first()).toContainText('Does finance have the final NO tax table?');
  const log = section.getByRole('listbox', { name: 'Decision log' });
  const note = log.getByRole('option').filter({ hasText: 'Google Pay waits for v2.1.' });
  await expect(note).toContainText('Why: one SDK update fewer before the freeze.');
  await expect(note).toContainText('Decided');
  await expect(log.getByText('Apple Pay ships after launch.')).toHaveCount(0);
  await expect(log.getByRole('option').filter({ hasText: 'Is Apple Pay in scope for launch?' })).toHaveCount(1);
  await section.scrollIntoViewIfNeeded();
  if (shots) await section.screenshot({ path: path.join(shots, '09-decisions.png') });
});

test('several epics group the tickets by epic', async ({ page }) => {
  await openInitiative(page, 'Mobile Onboarding');
  const tickets = page.getByRole('region', { name: 'Tickets' });
  await expect(tickets.locator('[data-epic]')).toHaveCount(2);
  await expect(tickets.locator('[data-epic="APP-88"]').getByRole('listitem')).toHaveCount(2);
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

test('Edit lists Slack conversations, docs and meetings row by row, and Refine fills the goal', async ({ page }) => {
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
  const docs = sheet.getByRole('group', { name: 'Doc' });
  await expect(docs.locator('[data-ref-row]')).toHaveCount(2);
  await expect(docs.getByLabel('Label for doc 1')).toHaveValue('Checkout v2 spec');
  await docs.getByRole('button', { name: 'Add Doc' }).click();
  await docs.getByLabel('Doc 3', { exact: true }).fill('https://docs.google.com/document/d/1CheckoutCopyDeck0000/edit');
  await docs.getByLabel('Label for doc 3').fill('Copy deck');
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
  const docList = page.getByRole('region', { name: 'Docs' });
  await expect(docList.getByRole('listitem')).toHaveCount(3);
  await expect(docList.getByRole('listitem').last()).toContainText('Google Doc');
  await expect(docList.getByRole('button', { name: 'Open Copy deck in the browser' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Goal' }).getByRole('heading', { name: 'Open questions' })).toBeVisible();
  await shot(page, '05-after-save.png');
});

test('an initiative’s page shows its tasks, ticks one off through the chat, links its epics and sets the check-in time', async ({ page }) => {
  await openInitiative(page, 'Checkout v2');
  await expect(page.getByRole('button', { name: 'Open epic SHOP-120 in Jira: One-page checkout' })).toBeVisible();
  const tasks = page.getByRole('region', { name: 'Tasks' });
  await expect(tasks.getByRole('list', { name: 'Scheduled', exact: true }).getByRole('listitem')).toHaveCount(1);
  await expect(tasks.getByRole('list', { name: 'Unscheduled', exact: true }).getByRole('listitem')).toHaveCount(2);
  await expect(tasks.getByRole('list', { name: 'Unscheduled', exact: true }).getByRole('listitem').first()).toHaveAttribute('data-task', 'demo-task-2');
  await expect(tasks.getByRole('list', { name: 'Done', exact: true }).getByRole('listitem')).toHaveCount(1);
  await expect(tasks.getByText(/3 open · 1 scheduled · 1 done/)).toBeVisible();
  await tasks.scrollIntoViewIfNeeded();
  await shot(page, '06-initiative-tasks.png');
  await tasks.getByRole('checkbox', { name: 'Complete Review the address form copy' }).click();
  const row = tasks.locator('[data-task="demo-task-3"]');
  await expect(row).toHaveAttribute('data-pending', 'complete');
  await expect(row).toContainText('Completing…');
  await expect(row.getByRole('checkbox')).toBeDisabled();
  await shot(page, '07-initiative-task-pending.png');
  const days = page.getByRole('group', { name: 'Check-in days' });
  await expect(days.getByRole('button', { name: 'Mon' })).toHaveAttribute('aria-pressed', 'true');
  await expect(days.getByRole('button', { name: 'Sat' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByLabel('Check-in time').fill('09:30');
  await expect(page.getByText(/Check-in every weekday at 9:30/)).toBeVisible();
  await days.getByRole('button', { name: 'Fri' }).click();
  await expect(page.getByText(/Check-in every week on Mon, Tue, Wed, Thu at 9:30/)).toBeVisible();
  await expect(days.getByRole('button', { name: 'Fri' })).toHaveAttribute('aria-pressed', 'false');
  await days.scrollIntoViewIfNeeded();
  await shot(page, '08-initiative-check-in-time.png');
});

test('an initiative’s page lists its people with what is open both ways, and People shows them across initiatives', async ({ page }) => {
  await openInitiative(page, 'Checkout v2');
  const people = page.getByRole('region', { name: 'People' });
  const rows = people.locator('[data-person]');
  await expect(rows).toHaveCount(2);
  const ana = people.locator('[data-person="ana-ruiz"]');
  await expect(ana).toContainText('Payments engineer');
  await expect(ana.getByRole('list', { name: 'Waiting on them' }).getByRole('listitem')).toHaveCount(2);
  const kai = people.locator('[data-person="kai-jensen"]');
  await expect(kai.getByRole('list', { name: 'They wait on you' })).toContainText('go/no-go agenda');
  await expect(kai).toContainText('Last talked: Yesterday');
  await people.scrollIntoViewIfNeeded();
  await shot(page, '09-initiative-people.png');
  await kai.getByRole('button', { name: 'Edit Kai Jensen' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Role in Checkout v2').fill('Finance lead');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(kai).toContainText('Finance lead');
  await people.getByRole('button', { name: 'Add a person' }).click();
  await page.getByRole('menuitem', { name: 'New Person…' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Mia Chen');
  await page.getByRole('dialog').getByLabel('Role in Checkout v2').fill('Design');
  await page.getByRole('dialog').getByRole('button', { name: 'Add Person' }).click();
  await expect(rows).toHaveCount(3);
  await people.getByRole('button', { name: 'Take Mia Chen off' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Take Off' }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'More for Checkout v2' }).click();
  await page.getByRole('menuitem', { name: 'People Across Initiatives' }).click();
  const all = page.getByRole('list', { name: 'People', exact: true });
  await expect(all.locator('[data-person]')).toHaveCount(3);
  await expect(all.locator('[data-person]').first()).toHaveAttribute('data-person', 'ana-ruiz');
  await expect(all.locator('[data-person="mia-chen"]').getByRole('button', { name: 'Remove Mia Chen' })).toBeVisible();
  await shot(page, '10-people-across.png');
});

test('a fresh initiative offers the people.md pass', async ({ page }) => {
  await openInitiative(page, 'Mobile Onboarding');
  const people = page.getByRole('region', { name: 'People' });
  await expect(people.getByRole('status')).toContainText('Nobody yet');
  await expect(people.getByRole('button', { name: 'Propose people from people.md' })).toBeVisible();
});
