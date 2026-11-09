import path from 'node:path';
import { expect, test, type Page } from '../fixtures.js';

/**
 * Everything works the same on a computer (BLG-795): the main flows again, on the demo's AWS
 * server's page, its link 80 ms away (the `remote` project: playwright.config.ts). Its worktree
 * opens tagged, with no slow or lost badge at that pace; chatting, the mode menu, Claude's terminal
 * view, changes and diffs, a file streamed in the reader, Copy Path instead of Finder, and a
 * worktree started there with Runs on and archived there all go as on this Mac.
 */

const SHOTS = process.env.E2E_SHOTS ?? path.join(import.meta.dirname, '../../../../.beluga/scratch');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const tab = (page: Page, name: string) => panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name, exact: true });
const tag = (page: Page) => page.getByTitle(/Runs on build-box/);

/** The build-box's webhook-retries, opened from Your Computers (`box`: wait for its message box; the terminal view may open without one). */
async function openThere(page: Page, box = true): Promise<void> {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Your Computers', exact: true }).click();
  await settings.getByRole('button', { name: 'Open webhook-retries on build-box' }).click();
  await expect(settings).toBeHidden();
  await expect(tag(page)).toBeVisible();
  if (box) await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);
  else await expect(page.getByRole('main').getByText('webhook-retries', { exact: true }).first()).toBeVisible();
}

/** What a terminal shows, as text (its buffer, read through the dev build's hook). */
const screen = (page: Page, key: RegExp) =>
  page.evaluate((src) => {
    const terms = (window as unknown as { __belugaTerms?: Record<string, { buffer: { active: { length: number; getLine: (y: number) => { translateToString: (t: boolean) => string } | undefined } } }> }).__belugaTerms ?? {};
    const re = new RegExp(src);
    const entry = Object.entries(terms).find(([k]) => re.test(k));
    if (!entry) return '';
    const buf = entry[1].buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
    return lines.join('\n');
  }, key.source);

test('a computer’s worktree 80 ms away: tagged without a slow badge, and chatting and modes go as here', async ({ page }) => {
  test.setTimeout(120_000);
  await openThere(page);
  // 80 ms is a good link: the tag says where, with no Slow or Reconnecting.
  await expect(tag(page)).toHaveAttribute('data-link', 'ok');
  await expect(tag(page).getByText(/Slow|Reconnecting/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 90_000 });

  // Typing is this window's own: every key lands at once, whatever the link.
  const box = composer(page);
  await box.fill('');
  await box.pressSequentially('how are the retries going?', { delay: 0 });
  await expect(box).toHaveValue('how are the retries going?');
  // The mode menu is this window's too: ⇧⇥ to Plan First and back.
  await box.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Mode: Plan First' })).toBeVisible();
  await box.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Mode: Act' })).toBeVisible();
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(page.getByRole('main').getByText('how are the retries going?').first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(SHOTS, 'blg-795-remote-chat.png') });
});

test('changes, a diff and a file streamed from the computer; its folder’s button copies the path', async ({ page }) => {
  await openThere(page);
  if (!(await panel(page).isVisible())) await page.keyboard.press('Meta+Alt+b');
  await tab(page, 'Changes').click();
  const first = panel(page).getByRole('option').first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  const name = ((await first.getAttribute('title')) ?? '').split('/').pop() ?? '';
  await first.click();
  const change = panel(page).getByRole('region', { name: `Changes in ${name}` });
  await expect(change).toBeVisible();
  // Worked out there; only the diff crosses (the demo's is a new file with no text differences).
  await expect(change.getByText('No differences in the text.').or(change.locator('tr').first())).toBeVisible();
  // The PR toolbar, as here.
  await expect(panel(page).getByRole('button', { name: 'Commit' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Create PR' })).toBeVisible();
  // The file as itself, read from the computer in pieces.
  await change.getByRole('tab', { name: 'File' }).click();
  await expect(change.locator('[class*="codeFile"]')).toBeVisible({ timeout: 15_000 });
  await expect(change.getByText('Can’t open this file')).toHaveCount(0);

  // Files: Show in Finder can't reach a computer, so its folder's path is copied instead.
  await tab(page, 'Files').click();
  await expect(panel(page).getByRole('button', { name: 'Copy Path' })).toBeVisible();
  const row = panel(page).locator('[role="treeitem"]:not([aria-expanded])').first();
  await expect(row).toBeVisible();
  const file = (await row.getAttribute('aria-label')) ?? '';
  // Read ahead under the pointer, then opened.
  await row.hover();
  await row.click();
  await expect(panel(page).getByRole('region', { name: file, exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(panel(page).getByRole('region', { name: file, exact: true }).getByText('Can’t open this file')).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, 'blg-795-remote-files.png') });
});

test('Claude’s terminal view streams from a computer’s worktree', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('beluga.prefs.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('beluga.prefs.v1') ?? '{}'), termView: true })));
  await openThere(page, false);
  await expect(page.getByRole('button', { name: 'Stop Claude' })).toHaveCount(0, { timeout: 90_000 });
  const modes = page.getByRole('tablist', { name: 'Show the conversation as' });
  await modes.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.locator('[data-pane="agent"] .xterm')).toBeVisible();
  await expect.poll(() => screen(page, /:agent$/), { timeout: 20_000 }).toContain('Claude Code');
  // Typed there, answered there: the terminal echoes at the link's pace.
  await page.locator('[data-pane="agent"] .xterm').click();
  await page.keyboard.type('map how a payment flows');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-visual]').filter({ hasText: 'How a payment goes through' })).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: path.join(SHOTS, 'blg-795-remote-terminal-view.png') });
});

test('a worktree started with Runs on the build-box is made there, then archived there', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
  await page.getByRole('button', { name: /^Runs on / }).click();
  await page.getByRole('menu', { name: 'Runs on' }).getByRole('menuitem', { name: /^build-box/ }).click();
  await page.getByRole('textbox', { name: 'Worktree name' }).fill('remote-check');
  await page.locator('textarea:not(.xterm-helper-textarea)').first().fill('Check the retries on the server');
  await page.getByRole('button', { name: /Create Worktree/ }).first().click();
  await expect(tag(page)).toBeVisible({ timeout: 20_000 });
  const row = sidebar(page).getByRole('button', { name: 'remote-check on build-box' });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Archive…' }).dispatchEvent('click');
  await page.getByRole('alertdialog', { name: /Archive “remote-check”/ }).getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
});

/** A task of the board whose worktree is still there (none yet: ''). */
const taskWithWorktree = (page: Page): Promise<string> =>
  page.evaluate(() => {
    type St = { board: { issues: Array<{ id: string; worktrees: string[]; carriedBy?: string }> }; projects: Array<{ workspaces: Array<{ id: string; archived?: boolean }> }> };
    const st = (window as unknown as { __belugaState?: () => St }).__belugaState?.();
    const live = new Set(st?.projects.flatMap((p) => p.workspaces.filter((w) => !w.archived).map((w) => w.id)) ?? []);
    return st?.board.issues.find((i) => live.has(i.carriedBy ?? i.worktrees.at(-1) ?? ''))?.id ?? '';
  });

/**
 * Every reveal button on a computer's page (BLG-852): a task's page there copies its worktree's
 * path (Copy Path) instead of opening Finder over there; on this Mac's page it's Reveal Folder.
 */
test('a task’s page on a computer says Copy Path for its worktree’s folder, and copies it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  // A task with a worktree (the demo's board seeds them a moment after it starts).
  let task = '';
  await expect.poll(async () => (task = await taskWithWorktree(page))).not.toBe('');
  const go = (view: object) => page.evaluate((v) => (window as unknown as { __belugaGo: (v: object) => void }).__belugaGo(v), view);
  // On this Mac: Reveal Folder.
  await go({ kind: 'task', id: task });
  await expect(page.getByRole('button', { name: 'Open Worktree' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reveal Folder' }).first()).toBeVisible();
  // The same task on the build-box: Copy Path, and the path is copied, never Finder over there.
  await go({ kind: 'machine', machine: 'de30a1c0ffee0002', view: { kind: 'task', id: task } });
  await expect(tag(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reveal Folder' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy Path' }).first().click();
  await expect(page.getByText(/Copied the path on build-box/)).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^\/.+/);
  await page.screenshot({ path: path.join(SHOTS, 'blg-852-task-copy-path.png') });
});
