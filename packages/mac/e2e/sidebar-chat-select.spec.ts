import { expect, test, type Page } from './fixtures.js';

/**
 * Shift+click selects a range of chats in the sidebar, in the order the screen shows them. A click
 * elsewhere clears it but keeps where it started, and Archive on the range says so once for all.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const NAMES = ['range-1', 'range-2', 'range-3', 'range-4'];
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  // Screenshots only: let animations settle so the picture is still.
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

/** A second connection to the demo daemon from the page (the app's own boot code), for driving it. */
async function daemon<T>(page: Page, fn: string, arg: unknown): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const w = window as unknown as { __range?: Promise<unknown> };
      w.__range ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      const c = await w.__range;
      return new Function('c', 'arg', `return (${fn})(c, arg)`)(c, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}

test('Shift+click selects a range, a click elsewhere keeps its start, and Archive says it once', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const project = await daemon<string>(page, `(c) => c.store.getState().projects.find((p) => p.name === 'bob-api').id`, null);
  await daemon(page, `async (c, { project, names }) => { for (const n of names) await c.api.workspaces.newChat(project, n); }`, { project, names: NAMES });
  const show = sidebar(page).getByRole('button', { name: /^Show what's in bob-api/ }).first();
  if (await show.isVisible()) await show.click();
  const chat = (name: string) => sidebar(page).locator(`[data-chat-id]`).filter({ has: page.getByText(name, { exact: true }) });
  for (const name of NAMES) await expect(chat(name)).toBeVisible();
  const order = await sidebar(page).locator('[data-chat-id]').evaluateAll((rows) => rows.map((r) => r.textContent ?? ''));
  const ours = NAMES.slice().sort((a, b) => order.findIndex((t) => t.includes(a)) - order.findIndex((t) => t.includes(b)));
  const status = sidebar(page).getByRole('status').filter({ hasText: /selected/ });

  // A Shift+click with nothing clicked before selects that one chat: "1 chat".
  await chat(ours[1]!).click({ modifiers: ['Shift'] });
  await expect(status).toContainText('1 chat selected');

  // Plain click starts the range; a click in the page clears it but keeps where it starts.
  await chat(ours[0]!).click();
  await expect(status).toBeHidden();
  await page.locator('textarea:not(.xterm-helper-textarea)').first().click();
  await chat(ours[2]!).click({ modifiers: ['Shift'] });
  await expect(status).toContainText('3 chats selected');
  await expect(sidebar(page).locator('[data-chat-selected]')).toHaveCount(3);
  // One box: open at the inner edges, closed at the outer ones.
  await expect(chat(ours[0]!)).toHaveAttribute('data-chat-join', 'down');
  await expect(chat(ours[1]!)).toHaveAttribute('data-chat-join', 'up down');
  await expect(chat(ours[2]!)).toHaveAttribute('data-chat-join', 'up');
  await expect(chat(ours[3]!)).not.toHaveAttribute('data-chat-join');
  await shot(page, 'chat-select-1-range');

  // One confirmation and one message for the three.
  await chat(ours[1]!).click({ button: 'right' });
  await shot(page, 'chat-select-2-menu');
  await page.getByRole('menuitem', { name: 'Archive 3 Chats…' }).click();
  const alert = page.getByRole('alertdialog', { name: /Archive 3 chats\?/ });
  await shot(page, 'chat-select-3-confirm');
  await alert.getByRole('button', { name: 'Archive 3 Chats' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Archived 3 chats.' })).toBeVisible({ timeout: 20_000 });
  await shot(page, 'chat-select-4-done');
  await expect(page.getByRole('status').filter({ hasText: /^Archived\. / })).toHaveCount(0);
  await expect(status).toBeHidden();
  for (const name of ours.slice(0, 3)) await expect(chat(name)).toHaveCount(0);
  await expect(chat(ours[3]!)).toBeVisible();
});
