import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * BLG-66: a search hit opens its conversation at its message and marks it for a moment: in a Your
 * Mac chat that isn't in memory (read from disk, then a long way up from the bottom), a worktree and
 * a chat shared with you.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const jumped = (page: Page) => page.locator('[data-jumped="true"]');
const field = (page: Page) => sidebar(page).getByRole('textbox', { name: 'Search chats and messages' });
const results = (page: Page) => sidebar(page).getByRole('listbox', { name: 'Search results' });
/** SHOTS=<folder>: save screenshots there. */
const shot = async (page: Page, name: string): Promise<void> => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

/** The demo's Your Mac folder: a temp folder of its own, in the daemon's home. */
function macFolder(): string {
  const tmp = path.join(process.env.BELUGA_HOME!, 'tmp');
  const name = readdirSync(tmp).find((n) => n.startsWith('beluga-demo-assistant-'));
  if (!name) throw new Error('the demo has no Your Mac folder');
  return path.join(tmp, name);
}

async function searchFor(page: Page, word: string): Promise<void> {
  await page.keyboard.press('Meta+Shift+F');
  const box = page.getByPlaceholder('Search every conversation');
  await box.fill(word);
  await expect(page.getByRole('option').first()).toContainText(word);
  await box.press('Enter');
}

test('a hit in a long Your Mac chat that is not in memory opens at its message, marked for a moment', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  await page.getByRole('button', { name: 'New chat with Your Mac' }).click();
  const dir = macFolder();
  let chat = '';
  await expect.poll(() => (chat = (JSON.parse(readFileSync(path.join(dir, 'chats.json'), 'utf8')) as { active: string }).active)).not.toBe('main');
  const channel = `mac:assistant:${chat}`;
  // Saved on disk only: it was never said in this run.
  const items = Array.from({ length: 80 }, (_, i) => ({ id: `m${i}`, type: 'chat', channel, from: 'me', name: 'kay', text: i === 8 ? 'the kumquat invoice is late' : `line ${i} of a long chat`, ts: 1_000_000 + i, byAgent: false }));
  expect(existsSync(path.join(dir, 'chats', chat))).toBe(true);
  writeFileSync(path.join(dir, 'chats', chat, 'history.json'), JSON.stringify(items));

  await searchFor(page, 'kumquat');
  await expect(page.getByRole('tablist', { name: 'Your Mac’s chats' }).getByRole('tab', { selected: true })).toContainText('line 0 of a long chat');
  await expect(jumped(page)).toContainText('the kumquat invoice is late');
  await expect(jumped(page)).toBeInViewport();
  await expect(page.getByText('line 79 of a long chat')).not.toBeInViewport();
  await expect(jumped(page)).toHaveCount(0, { timeout: 4000 });
});

test('a hit in a worktree opens that worktree at its message', async ({ page }) => {
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await composer(page).fill('remember the mulberry key');
  await composer(page).press('Enter');
  await expect(page.getByText('remember the mulberry key').last()).toBeVisible();
  await sidebar(page).getByText('Your Mac', { exact: true }).click();

  await searchFor(page, 'mulberry');
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await expect(jumped(page)).toContainText('remember the mulberry key');
});

test('a hit on a message that waited in the queue opens at that message', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  await sidebar(page).getByRole('button', { name: 'bob-api' }).first().waitFor();
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await composer(page).fill('Take a deep dive into the codebase');
  await composer(page).press('Enter');
  const split = page.getByRole('group', { name: 'Claude is working' });
  await expect(split).toBeVisible();
  await composer(page).fill('the pomelo question');
  await split.getByRole('button', { name: 'Queue' }).click();
  const tray = page.getByRole('region', { name: 'Queued messages' });
  await expect(tray.getByRole('listitem')).toHaveText([/the pomelo question/]);
  // It left the queue and ran: the chat draws it where it ran, not when it was typed.
  await expect(tray).toBeHidden({ timeout: 90_000 });
  await sidebar(page).getByText('Your Mac', { exact: true }).click();

  await searchFor(page, 'pomelo');
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);
  await expect(jumped(page)).toContainText('the pomelo question');
});

test('a hit older than what the chat keeps says so, and the chat stays at its latest messages', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  await page.getByRole('button', { name: 'New chat with Your Mac' }).click();
  const dir = macFolder();
  let chat = '';
  await expect.poll(() => (chat = (JSON.parse(readFileSync(path.join(dir, 'chats.json'), 'utf8')) as { active: string }).active)).not.toBe('main');
  const channel = `mac:assistant:${chat}`;
  const items = Array.from({ length: 1200 }, (_, i) => ({ id: `m${i}`, type: 'chat', channel, from: 'me', name: 'kay', text: i === 5 ? 'the ancient quince note' : `line ${i} of a very long chat`, ts: 1_000_000 + i, byAgent: false }));
  writeFileSync(path.join(dir, 'chats', chat, 'history.json'), JSON.stringify(items));

  await searchFor(page, 'quince');
  await expect(page.getByText('That message is too old to show here. The chat shows its latest messages.')).toBeVisible();
  await expect(page.getByText('line 1199 of a very long chat')).toBeInViewport();
  await expect(jumped(page)).toHaveCount(0);
});

test('a hit in a chat shared with you opens that chat at its message', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page).getByRole('button', { name: 'bob-api, shared by bob' })).toBeVisible();
  // Its history lands just after the invite: search again until bob's words are in the hits.
  await page.keyboard.press('Meta+Shift+F');
  const box = page.getByPlaceholder('Search every conversation');
  const hit = page.getByRole('option').filter({ hasText: 'idempotency key check' });
  await expect(async () => {
    await box.fill('');
    await box.fill('idempotency');
    await expect(hit).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await hit.click();
  await expect(jumped(page)).toContainText('idempotency key check');
});

test('a hit on the answer of a turn you spoke during opens at the answer, below what you said', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'new-hero', exact: true });
  await sidebar(page).getByRole('button', { name: 'landing' }).first().waitFor();
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'landing' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await composer(page).fill('walk the codebase and tell me what is risky');
  await composer(page).press('Enter');
  await expect(page.locator('[data-turn]').last().locator('[data-step]').nth(1)).toBeVisible({ timeout: 15_000 });
  // Said mid-turn: the turn is drawn in two, its answer below this message.
  await composer(page).fill('also look at the retry logic');
  await composer(page).press('Alt+Enter');
  await expect(page.locator('[data-turn="done"][data-turn-part="tail"]')).toBeVisible({ timeout: 60_000 });
  await sidebar(page).getByText('Your Mac', { exact: true }).click();

  await field(page).fill('weak spot');
  const hit = results(page).getByRole('option').filter({ hasText: 'new-hero' }).filter({ hasText: 'weak spot' }).first();
  await expect(hit).toBeVisible();
  await shot(page, 'split-turn-hit');
  await hit.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /new-hero/);
  await expect(jumped(page).locator('[data-turn-part="tail"]')).toContainText('Walked the codebase');
  await expect(jumped(page)).toBeInViewport();
  await shot(page, 'split-turn-answer-marked');
});

test('a hit in a group chat opens that chat, as the sidebar does', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible()) await card.getByRole('button', { name: 'Turn On' }).click();
  const launch = sidebar(page).getByRole('button', { name: /^Channel launch\b/ });
  await expect(launch).toBeVisible({ timeout: 30_000 });
  await launch.click();
  const log = page.getByRole('log', { name: 'Channel launch' });
  await expect(log).toContainText('Checklist for Friday', { timeout: 20_000 });
  // Your agent answers in the group: its turn is what search finds there.
  const before = await log.locator('[data-claude="true"]').count();
  await page.getByRole('button', { name: 'Ask: your agent', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message launch' }).fill('visualize the payment flow');
  await page.getByRole('button', { name: 'Send and asking your agent' }).click();
  await expect(log.locator('[data-claude="true"]')).toHaveCount(before + 1, { timeout: 30_000 });
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  await expect(log).toBeHidden();

  // Newest first: the answer just given.
  await field(page).fill('double-charge');
  const hit = results(page).getByRole('option').first();
  await expect(hit).toContainText('double-charge', { timeout: 15_000 });
  await shot(page, 'group-hit');
  await hit.click();
  await expect(log).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Chats' }).getByRole('tab', { name: 'launch' })).toHaveAttribute('aria-selected', 'true');
  await shot(page, 'group-opened');
});
