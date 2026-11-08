import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * Sidebar categories: with the setting on, each chat is in Inbox, Working, Later or Settled, and
 * you move it from its row. With it off, the sidebar is as it was.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea):not([aria-label="Plan name"]):not([aria-label="Message your agent about the plan"])');
const list = (page: Page, title: string): Locator => sidebar(page).getByRole('region', { name: title, exact: true });
const inList = (page: Page, title: string, name: string): Locator => list(page, title).getByRole('button', { name: new RegExp(`^${name} ·`) });
const unfold = async (page: Page, title: string): Promise<void> => {
  const head = list(page, title).getByRole('button', { name: new RegExp(`^${title}`) }).first();
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
};

async function setCategories(page: Page, on: boolean): Promise<void> {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'Appearance' }).click();
  const toggle = page.getByRole('switch', { name: 'Sidebar categories' });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
  await page.keyboard.press('Escape');
}

async function openFromInbox(page: Page, name: string): Promise<void> {
  await inList(page, 'Inbox', name).click();
  await expect(composer(page)).toHaveAttribute('placeholder', new RegExp(name));
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: /^(Projects|Chats)/ }).first()).toBeVisible();
});

test('the setting swaps Unread and Chats for the categories, folds Projects, and gives your folds back', async ({ page }) => {
  await setCategories(page, false);
  const chatsHead = sidebar(page).getByRole('button', { name: 'Chats', exact: true });
  await chatsHead.click();
  await expect(chatsHead).toHaveAttribute('aria-expanded', 'false');
  const projects = sidebar(page).getByRole('button', { name: 'Projects', exact: true });
  await expect(projects).toHaveAttribute('aria-expanded', 'true');

  await setCategories(page, true);
  await expect(chatsHead).toHaveCount(0);
  await expect(sidebar(page).getByRole('region', { name: 'Unread' })).toHaveCount(0);
  await expect(list(page, 'Inbox')).toBeVisible();
  await expect(projects).toHaveAttribute('aria-expanded', 'false');
  // Projects can be opened.
  await projects.click();
  await expect(sidebar(page).getByRole('button', { name: 'bob-api', exact: true })).toBeVisible();

  await setCategories(page, false);
  await expect(chatsHead).toHaveAttribute('aria-expanded', 'false');
  await expect(projects).toHaveAttribute('aria-expanded', 'true');
  await expect(list(page, 'Inbox')).toHaveCount(0);
});

test.describe('with the setting on', () => {
  test.beforeEach(async ({ page }) => {
    await setCategories(page, true);
    await expect(list(page, 'Inbox')).toBeVisible();
  });

  test('a running chat moves to Working, and back to Inbox when its turn ends', async ({ page }) => {
    test.setTimeout(90_000);
    await openFromInbox(page, 'add-auth');
    await composer(page).fill('Take a deep dive into the webhooks, take your time');
    await composer(page).press('Enter');
    // You are in it: it shows in Working however that list is folded.
    await expect(inList(page, 'Working', 'add-auth')).toBeVisible({ timeout: 10_000 });
    await expect(inList(page, 'Working', 'add-auth').locator('[data-status="working"]')).toContainText('Working');
    // Working has no Settle: only Remind Me Later.
    await inList(page, 'Working', 'add-auth').hover();
    await expect(page.getByRole('button', { name: 'Remind me later about add-auth' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settle add-auth' })).toHaveCount(0);
    await inList(page, 'Working', 'add-auth').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: /^Settle/ })).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect(inList(page, 'Inbox', 'add-auth')).toBeVisible({ timeout: 45_000 });
  });

  test("a question moves a chat to Inbox with 'Input', from Working and from Later", async ({ page }) => {
    test.setTimeout(120_000);
    await openFromInbox(page, 'new-hero');
    const asked = inList(page, 'Inbox', 'new-hero');
    const answer = async (): Promise<void> => {
      await expect(asked.locator('[data-status="need"]')).toHaveText('Input', { timeout: 60_000 });
      // Putting the open chat off moved you on: back to it.
      await asked.click();
      await page.getByRole('button', { name: /Signed cookies/ }).click();
      await expect(asked.locator('[data-status="need"]')).toHaveCount(0, { timeout: 15_000 });
    };

    // From Working: the turn runs, then it asks.
    await composer(page).fill('Which session store should we pick for auth?');
    await composer(page).press('Enter');
    await answer();

    // From Later: a long turn, the question queued after it, and Remind Me Later while that turn runs.
    await composer(page).fill('Take a deep dive into the webhooks, take your time');
    await composer(page).press('Enter');
    await expect(inList(page, 'Working', 'new-hero')).toBeVisible({ timeout: 10_000 });
    await composer(page).fill('Which session store should we pick for auth?');
    await composer(page).press('Enter');
    await inList(page, 'Working', 'new-hero').hover();
    await page.getByRole('button', { name: 'Remind me later about new-hero' }).click();
    await page.getByRole('menuitem', { name: /^In 3 Hours/ }).click();
    await expect(inList(page, 'Later', 'new-hero')).toBeVisible();
    await answer();
  });

  test('settles a chat from its row, sends a message there and sees it in Working', async ({ page }) => {
    test.setTimeout(90_000);
    await openFromInbox(page, 'webhook-retries');
    await inList(page, 'Inbox', 'webhook-retries').hover();
    await page.getByRole('button', { name: 'Settle webhook-retries' }).click();
    await expect(list(page, 'Settled')).toBeVisible();
    await unfold(page, 'Settled');
    await expect(inList(page, 'Settled', 'webhook-retries')).toBeVisible();
    // You moved on to the next Inbox row. Back in it, the line says why and the box still works.
    await expect(composer(page)).not.toHaveAttribute('placeholder', /webhook-retries/);
    await inList(page, 'Settled', 'webhook-retries').click();
    await expect(page.getByRole('status', { name: 'Chat category' })).toContainText('Settled by you');
    await composer(page).fill('Take a deep dive into the webhooks, take your time');
    await composer(page).press('Enter');
    await expect(inList(page, 'Working', 'webhook-retries')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('status', { name: 'Chat category' })).toHaveCount(0);
    await expect(inList(page, 'Inbox', 'webhook-retries')).toBeVisible({ timeout: 45_000 });
  });

  test('puts a chat off with a preset, sees the time left, shows it again and sees it in Inbox', async ({ page }) => {
    const name = 'new-hero';
    await expect(inList(page, 'Inbox', name)).toBeVisible();
    await inList(page, 'Inbox', name).hover();
    await page.getByRole('button', { name: `Remind me later about ${name}` }).click();
    await expect(page.getByRole('menuitem', { name: /^Custom/ })).toBeVisible();
    await page.getByRole('menuitem', { name: /^In 1 Hour/ }).click();
    await unfold(page, 'Later');
    const later = inList(page, 'Later', name);
    await expect(later.locator('[data-status="left"]')).toHaveText(/(59m|1h) left/);
    await later.hover();
    await page.getByRole('button', { name: `Show ${name} again now` }).click();
    await expect(inList(page, 'Inbox', name).locator('[data-status="back"]')).toHaveText('Back');
  });

  test('un-settles a chat from the line above its message box', async ({ page }) => {
    await inList(page, 'Inbox', 'add-auth').hover();
    await page.getByRole('button', { name: 'Settle add-auth' }).click();
    await unfold(page, 'Settled');
    await inList(page, 'Settled', 'add-auth').click();
    await page.getByRole('status', { name: 'Chat category' }).getByRole('button', { name: 'Un-settle' }).click();
    await expect(inList(page, 'Inbox', 'add-auth')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Chat category' })).toHaveCount(0);
  });

  test('puts a chat off until a date and time you pick, and shows it again from its line', async ({ page }) => {
    await inList(page, 'Inbox', 'add-auth').hover();
    await page.getByRole('button', { name: 'Remind me later about add-auth' }).click();
    await page.getByRole('menuitem', { name: /^Custom/ }).click();
    await page.getByRole('textbox', { name: 'Date and time' }).fill('2099-01-05T09:00');
    await page.getByRole('button', { name: 'Remind Me', exact: true }).click();
    await unfold(page, 'Later');
    await inList(page, 'Later', 'add-auth').click();
    await expect(page.getByRole('status', { name: 'Chat category' })).toContainText('Reminds you');
    await page.getByRole('status', { name: 'Chat category' }).getByRole('button', { name: 'Show Again Now' }).click();
    await expect(inList(page, 'Inbox', 'add-auth')).toBeVisible();
  });

  test('a DM with news is in Inbox with no settle or Remind Me Later', async ({ page }) => {
    const dm = inList(page, 'Inbox', 'bob');
    await dm.hover();
    await expect(page.getByRole('button', { name: 'Remind me later about bob' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Settle bob' })).toHaveCount(0);
  });

  test('Work Again opens the chat and puts you in its message box, from each menu', async ({ page }) => {
    await inList(page, 'Inbox', 'add-auth').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Work Again' }).click();
    await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
    await expect(composer(page)).toBeFocused();
  });

  test('Work Again on a plan row opens the plan and puts you in its message box', async ({ page }) => {
    await sidebar(page).getByRole('button', { name: /^Card checkout for launch ·/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Work Again' }).click();
    await expect(page.getByRole('textbox', { name: 'Message your agent about the plan' })).toBeFocused();
  });

  test('a Show Again Now or an Un-settle that fails from the line above the message box says so', async ({ page }) => {
    await page.routeWebSocket(/.*/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const frame = typeof message === 'string' && message.startsWith('{') ? (JSON.parse(message) as { t?: string; id?: string; method?: string }) : undefined;
        if (frame?.t === 'call' && (frame.method === 'triage.wake' || frame.method === 'triage.unsettle')) ws.send(JSON.stringify({ t: 'result', id: frame.id, ok: false, error: `Refused ${frame.method}` }));
        else server.send(message);
      });
    });
    await page.reload();
    const line = page.getByRole('status', { name: 'Chat category' });

    await inList(page, 'Inbox', 'new-hero').hover();
    await page.getByRole('button', { name: 'Remind me later about new-hero' }).click();
    await page.getByRole('menuitem', { name: /^In 1 Hour/ }).click();
    await unfold(page, 'Later');
    await inList(page, 'Later', 'new-hero').click();
    await line.getByRole('button', { name: 'Show Again Now' }).click();
    await expect(page.getByText('Refused triage.wake')).toBeVisible();
    await expect(inList(page, 'Later', 'new-hero')).toBeVisible();

    await inList(page, 'Inbox', 'webhook-retries').hover();
    await page.getByRole('button', { name: 'Settle webhook-retries' }).click();
    await unfold(page, 'Settled');
    await inList(page, 'Settled', 'webhook-retries').click();
    await line.getByRole('button', { name: 'Un-settle' }).click();
    await expect(page.getByText('Refused triage.unsettle')).toBeVisible();
    await expect(inList(page, 'Settled', 'webhook-retries')).toBeVisible();
  });
});

test('a chat put off with the setting off is in Later once it is on, Remind Me Later is the one way to put off, and the header shows archived chats', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  // The tests before this one may leave the setting on.
  await setCategories(page, false);
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  // The project's page is in (it takes focus as it comes, which would close a menu).
  await expect(page.getByText('What do you want to do in bob-api?')).toBeVisible({ timeout: 30_000 });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remind Me Later' }).hover();
  await page.getByRole('menuitem', { name: /^In 1 Hour/ }).click();
  await expect(sidebar(page).getByRole('button', { name: 'Later, 1' })).toBeVisible();
  await setCategories(page, true);
  await expect(inList(page, 'Inbox', 'add-auth')).toHaveCount(0);
  await unfold(page, 'Later');
  await expect(inList(page, 'Later', 'add-auth')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('later-list.png') });

  // Every chat offers Remind Me Later: there is no other Snooze.
  await sidebar(page).getByRole('button', { name: 'Projects' }).click();
  const other = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  await other.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Remind Me Later' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Snooze' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The one put off can come back.
  await inList(page, 'Later', 'add-auth').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /Show Again Now/ })).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(list(page, 'Inbox').getByRole('button', { name: 'Chats Options' })).toHaveCount(0);
  const text = 'Plan the spring trip';
  await list(page, 'Inbox').getByRole('button', { name: 'New chat (not tied to a project)' }).click();
  // The new chat's box, not the project page's that it replaces.
  await expect(page.getByText('Nothing is created until you send the first message')).toBeVisible();
  await composer(page).fill(text);
  await composer(page).press('Enter');
  const chat = sidebar(page).getByRole('button', { name: new RegExp(`^${text} ·`) });
  await expect(inList(page, 'Inbox', text)).toBeVisible({ timeout: 30_000 });
  await chat.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Archive/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^Archive/ }).click();
  await expect(list(page, 'Inbox').getByRole('button', { name: 'Chats Options' })).toBeVisible();
});
