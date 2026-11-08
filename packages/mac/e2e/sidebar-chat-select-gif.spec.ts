import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * Frames of a Shift-click selection for a pull request's GIF, at its real speed: it grows, shrinks,
 * opens its menu and clears. Sharp (2x) pictures of the sidebar, one after another, and how long
 * each stayed. Only with GIF set to a folder:
 *   GIF=/tmp/frames npm run e2e -- e2e/sidebar-chat-select-gif.spec.ts   → frames + frames.txt (ffmpeg concat)
 */

test.skip(!process.env.GIF, 'records frames for a GIF');
test.use({ deviceScaleFactor: 2 });

/** The sidebar from its lists' middle down to the selection's count under them. */
const CLIP = { x: 0, y: 330, width: 400, height: 500 };

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const NAMES = ['Fix login redirect', 'Rename billing tables', 'Draft release notes', 'Flaky upload test', 'Tidy onboarding copy'];

async function daemon<T>(page: Page, fn: string, arg: unknown): Promise<T> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const w = window as unknown as { __gif?: Promise<unknown> };
      w.__gif ??= import('/src/lib/boot.ts').then((m) => m.connect(m.capabilities(() => ({ ok: true, message: '' }))));
      const c = await w.__gif;
      return new Function('c', 'arg', `return (${fn})(c, arg)`)(c, arg);
    },
    { fn, arg },
  ) as Promise<T>;
}

test('selecting a range of chats', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const project = await daemon<string>(page, `(c) => c.store.getState().projects.find((p) => p.name === 'bob-api').id`, null);
  await daemon(page, `async (c, { project, names }) => { for (const n of names) await c.api.workspaces.newChat(project, n); }`, { project, names: NAMES });
  const show = sidebar(page).getByRole('button', { name: /^Show what's in bob-api/ }).first();
  if (await show.isVisible()) await show.click();
  const chat = (name: string) => sidebar(page).locator('[data-chat-id]').filter({ has: page.getByText(name, { exact: true }) });
  for (const name of NAMES) await expect(chat(name)).toBeVisible();
  const order = await sidebar(page).locator('[data-chat-id]').evaluateAll((rows) => rows.map((r) => r.textContent ?? ''));
  const rows = NAMES.slice().sort((a, b) => order.findIndex((t) => t.includes(a)) - order.findIndex((t) => t.includes(b)));
  const pause = (ms: number) => page.waitForTimeout(ms);

  const dir = process.env.GIF!;
  mkdirSync(dir, { recursive: true });
  const frames: Array<{ file: string; at: number }> = [];
  let recording = true;
  const recorder = (async () => {
    while (recording) {
      const at = Date.now();
      const file = path.join(dir, `f${String(frames.length).padStart(4, '0')}.png`);
      await page.screenshot({ path: file, clip: CLIP });
      frames.push({ file, at });
    }
  })();

  await pause(900);
  await chat(rows[0]!).click();
  await pause(900);
  await chat(rows[2]!).click({ modifiers: ['Shift'] });
  await pause(1300);
  await chat(rows[4]!).click({ modifiers: ['Shift'] });
  await pause(1300);
  await chat(rows[1]!).click({ modifiers: ['Shift'] });
  await pause(1300);
  await chat(rows[3]!).click({ modifiers: ['Shift'] });
  await pause(1000);
  await chat(rows[2]!).click({ button: 'right' });
  await pause(1600);
  await page.keyboard.press('Escape');
  await pause(500);
  await page.keyboard.press('Escape');
  await pause(1200);

  recording = false;
  await recorder;
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.at ?? f.at + 100) - f.at) / 1000).toFixed(3)}`);
  writeFileSync(path.join(dir, 'frames.txt'), `${list.join('\n')}\nfile '${frames.at(-1)!.file}'\n`);
});
