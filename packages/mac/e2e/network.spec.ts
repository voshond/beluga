import { expect, test, type Page } from './fixtures.js';

/**
 * Friends, groups and your status (the Beluga network) against the demo: turned on from the
 * sidebar's card (it starts live, no restart), bob and mia as friends who answer, a group.
 * The last test turns it off again in Settings, so the other specs see the sidebar as before.
 */

test.describe.configure({ mode: 'serial' });

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const friend = (page: Page, name: string) => sidebar(page).getByRole('button', { name: new RegExp(`^${name}, `) });
const group = (page: Page, name: string) => sidebar(page).getByRole('button', { name: new RegExp(`^Channel ${name}\\b`) });
const toolbar = (page: Page) => page.locator('header').first();

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('the Friends card turns the network on, and friends show with their status', async ({ page }) => {
  // The run's demo starts with the network on (its friends are on it): off first, from Settings.
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('button', { name: 'People & access' }).click();
  const on = page.getByRole('switch', { name: 'Talk with friends directly' });
  if ((await on.getAttribute('aria-checked')) === 'true') await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  const card = sidebar(page).getByRole('group', { name: 'Talk with friends' });
  await expect(card).toContainText('No server');
  await card.getByRole('button', { name: 'Turn On' }).click();
  await expect(friend(page, 'bob')).toBeVisible({ timeout: 30_000 });
  await expect(friend(page, 'bob')).toHaveAccessibleName(/^bob, Online/);
  await expect(friend(page, 'mia')).toHaveAccessibleName(/^mia, Away · 📅 in a meeting/, { timeout: 15_000 });
  await expect(group(page, 'launch')).toBeVisible();
  // Your own status at the bottom of the sidebar.
  await expect(page.getByRole('button', { name: /^Your status: Online/ })).toBeVisible();
});

test('a direct message goes to bob, and his answer comes back', async ({ page }) => {
  await friend(page, 'bob').click();
  await expect(toolbar(page)).toContainText('bob');
  await expect(page.getByRole('log', { name: 'Conversation with bob' })).toContainText('Could you look at the deploy script later?');
  const box = page.getByRole('textbox', { name: 'Message bob' });
  await box.fill('Sure, after lunch');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  const log = page.getByRole('log', { name: 'Conversation with bob' });
  await expect(log).toContainText('Sure, after lunch');
  await expect(log).toContainText('On it: “Sure, after lunch”', { timeout: 15_000 });
  // Reading it here: no unread badge on his row.
  await expect(friend(page, 'bob')).not.toHaveAccessibleName(/unread/);
});

test('a chat with a friend opens scrolled all the way down', async ({ page }) => {
  const fill = async (name: string): Promise<void> => {
    await friend(page, name).click();
    const box = page.getByRole('textbox', { name: `Message ${name}` });
    for (let i = 1; i <= 14; i++) {
      await box.fill(`Line ${i}\n\nwith a second paragraph`);
      await box.press('Enter');
    }
    await expect(page.getByRole('log', { name: `Conversation with ${name}` })).toContainText('Line 14');
  };
  const atBottom = async (name: string): Promise<void> => {
    const log = page.getByRole('log', { name: `Conversation with ${name}` });
    await expect(log).toBeVisible();
    await expect.poll(() => log.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
    await expect.poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
  };
  await fill('mia');
  await fill('bob');
  // Reading further up in bob's chat doesn't carry over: mia's opens at her newest message.
  await page.getByRole('log', { name: 'Conversation with bob' }).evaluate((el) => {
    el.scrollTop = 0;
  });
  await friend(page, 'mia').click();
  await atBottom('mia');
  await friend(page, 'bob').click();
  await atBottom('bob');
});

test('what came in while you were away is marked when you come back, at the bottom (BLG-573)', async ({ page }) => {
  await friend(page, 'bob').click();
  const box = page.getByRole('textbox', { name: 'Message bob' });
  await box.fill('Ping while I’m away');
  await box.press('Enter');
  // His answer lands while mia's chat is open: unread on his row.
  await friend(page, 'mia').click();
  await expect(friend(page, 'bob')).toHaveAccessibleName(/unread/, { timeout: 15_000 });
  await friend(page, 'bob').click();
  const log = page.getByRole('log', { name: 'Conversation with bob' });
  await expect(log.getByText(/^(New message|\d+ new messages)$/)).toBeVisible();
  await expect(log).toContainText('On it: “Ping while I’m away”');
  await expect.poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(4);
  await shot(page, 'unread-marked');
  // Read now: the next visit has no line.
  await friend(page, 'mia').click();
  await friend(page, 'bob').click();
  await expect(log).toContainText('On it: “Ping while I’m away”');
  await expect(log.getByText(/^(New message|\d+ new messages)$/)).toHaveCount(0);
});

/** SHOTS=<folder>: save screenshots there. */
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};

test('your direct message can be edited and deleted; the chat can be cleared (BLG-425)', async ({ page }) => {
  await friend(page, 'bob').click();
  const log = page.getByRole('log', { name: 'Conversation with bob' });
  const box = page.getByRole('textbox', { name: 'Message bob' });
  await box.fill('Lunch at 12?');
  await box.press('Enter');
  const mine = log.locator('[data-mine="true"]', { hasText: 'Lunch at 12?' });
  await expect(mine).toBeVisible();
  await mine.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete…' })).toBeVisible();
  await shot(page, '01-message-menu');
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const editor = log.getByRole('textbox', { name: 'Edit message' });
  await editor.fill('Lunch at 1?');
  await shot(page, '02-editing');
  await editor.press('Enter');
  const edited = log.locator('[data-mine="true"]', { hasText: 'Lunch at 1?' });
  await expect(edited).toContainText('Edited');
  await shot(page, '03-edited');

  await edited.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const alert = page.getByRole('alertdialog', { name: 'Delete this message?' }).or(page.getByRole('dialog', { name: 'Delete this message?' }));
  await expect(alert).toContainText('bob’s');
  await shot(page, '04-delete-alert');
  await alert.getByRole('button', { name: 'Delete' }).click();
  await expect(edited).toHaveCount(0);

  await toolbar(page).getByRole('button', { name: 'More for bob' }).click();
  await page.getByRole('menuitem', { name: 'Clear Chat…' }).click();
  const clear = page.getByRole('alertdialog', { name: 'Clear your chat with bob?' }).or(page.getByRole('dialog', { name: 'Clear your chat with bob?' }));
  await shot(page, '05-clear-alert');
  await clear.getByRole('button', { name: 'Clear' }).click();
  await expect(log.locator('[data-message]')).toHaveCount(0);
});

test('a new group with bob and mia: create, rename in its info, then leave', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'New channel' }).click();
  const sheet = page.getByRole('dialog', { name: 'New Channel' });
  await sheet.getByLabel('Name').fill('Weekend');
  await sheet.getByRole('checkbox').nth(0).check();
  await sheet.getByRole('checkbox').nth(1).check();
  await expect(sheet).toContainText('2 friends chosen');
  await sheet.getByRole('button', { name: 'Create' }).click();
  await expect(sheet).toBeHidden();
  await expect(group(page, 'Weekend')).toBeVisible();
  await expect(toolbar(page)).toContainText('Weekend');
  // Each person here as a pill in the header (BLG-210), you first.
  await expect(toolbar(page).getByRole('list', { name: 'People here' }).getByRole('listitem')).toHaveText([/You/, /bob|mia/, /bob|mia/]);

  const box = page.getByRole('textbox', { name: 'Message Weekend' });
  await box.fill('Hiking on Saturday?');
  await box.press('Enter');
  await expect(page.getByRole('log', { name: 'Channel Weekend' })).toContainText('Hiking on Saturday?');

  // Rename it in place in the group's info.
  await page.getByRole('button', { name: /Weekend: 3 members, group info/ }).click();
  const info = page.getByRole('dialog', { name: 'About Weekend' });
  await expect(info).toContainText('Admin');
  const name = info.getByRole('textbox', { name: 'Channel name' });
  await name.fill('Weekend hike');
  await name.press('Enter');
  await expect(group(page, 'Weekend hike')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');

  // Leave it: an alert first, then it stays, read-only.
  await toolbar(page).getByRole('button', { name: 'More for Weekend hike' }).click();
  await page.getByRole('menuitem', { name: 'Leave Channel…' }).click();
  const alert = page.getByRole('alertdialog', { name: 'Leave Weekend hike?' });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: 'Leave' }).click();
  await expect(page.getByText('You’re no longer in Weekend hike')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('textbox', { name: 'Message Weekend hike' })).toHaveCount(0);
});

test('Add a Friend shows a code and a link, and says when a code is wrong', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'Add a friend' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a Friend' });
  const create = sheet.getByRole('button', { name: 'Create Invitation' });
  if (await create.isVisible()) await create.click();
  await expect(sheet.getByLabel(/^Invitation code [0-9A-Z]{4}-[0-9A-Z]{4}/)).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByRole('button', { name: 'Copy Link' })).toBeVisible();
  await expect(sheet.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expect(sheet).toContainText(/works for|Expires in/);

  const field = sheet.getByRole('textbox', { name: 'Invitation code or link' });
  await field.fill('hello there');
  await sheet.getByRole('button', { name: 'Add Friend' }).click();
  await expect(sheet.getByRole('alert')).toContainText('doesn’t look like a Beluga invitation');
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();
});

test('your status: Do Not Disturb from the sidebar, then back to Online', async ({ page }) => {
  await page.getByRole('button', { name: /^Your status/ }).click();
  const card = page.getByRole('dialog', { name: 'Your status' });
  await card.getByRole('radio', { name: /Do Not Disturb/ }).click();
  await expect(page.getByRole('button', { name: /^Your status: Do Not Disturb/ })).toBeVisible();
  await page.getByRole('button', { name: /^Your status/ }).click();
  await expect(card.getByRole('radio', { name: /Do Not Disturb/ })).toHaveAttribute('aria-checked', 'true');
  await card.getByRole('radio', { name: /^Online/ }).click();
  await expect(page.getByRole('button', { name: /^Your status: Online/ })).toBeVisible();
});

test('your status gets an emoji next to its note, and a friend’s shows by their name', async ({ page }) => {
  await expect(friend(page, 'mia').getByText('📅')).toBeVisible({ timeout: 15_000 });
  await shot(page, '06-friends-emoji');
  await page.getByRole('button', { name: /^Your status/ }).click();
  const card = page.getByRole('dialog', { name: 'Your status' });
  await card.getByRole('textbox', { name: 'Status note' }).fill('Beluga');
  await card.getByRole('textbox', { name: 'Status note' }).press('Tab');
  await card.getByRole('button', { name: 'Pick a status emoji' }).click();
  await shot(page, '07-emoji-picker');
  await page.getByRole('dialog', { name: 'Status emoji' }).getByRole('button', { name: '🐋' }).click();
  await expect(page.getByRole('button', { name: /^Your status: Online · 🐋 Beluga/ })).toBeVisible();
  await shot(page, '08-status-set');
  await card.getByRole('button', { name: 'Clear the note and emoji' }).click();
  await expect(page.getByRole('button', { name: /^Your status: Online$/ })).toBeVisible();
});

test('a friend’s right-click menu: Message, Add to Channel, Copy Name, Remove…', async ({ page }) => {
  await friend(page, 'mia').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Message' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Add to Channel' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Copy Name' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Remove mia…' }).click();
  const alert = page.getByRole('alertdialog', { name: 'Remove mia?' });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: 'Cancel' }).click();
  await expect(alert).toBeHidden();
  await expect(friend(page, 'mia')).toBeVisible();
});

test('Settings › People & access turns it off again: the Friends card comes back', async ({ page }) => {
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: 'People & access' }).click();
  const on = page.getByRole('switch', { name: 'Talk with friends directly' });
  await expect(on).toHaveAttribute('aria-checked', 'true');
  await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(sidebar(page).getByRole('group', { name: 'Talk with friends' })).toBeVisible();
  await expect(friend(page, 'bob')).toHaveCount(0);
});
