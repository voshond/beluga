import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { demoPdf } from '../../../src/demo-pdf.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * The panel's Scratch tab: what Claude saves to the workspace's .beluga/scratch/ while it works, live and
 * newest first. Until you pick one, the preview shows each new file as it's written (JSON laid out, pictures
 * as pictures, redrawn when they change); picking one stays on it, and a log scrolled to its end follows it.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Panel' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');
const tab = (page: Page, name: string) => panel(page).getByRole('tablist', { name: 'Panel' }).getByRole('tab', { name, exact: true });

// 2×2 PNGs, red and blue.
const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==', 'base64');
// A 16×16 WebM, a fifth of a second.
const CLIP = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIAEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggHq7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAxV0GNTGF2ZjYyLjEyLjEwMUSJiEBpAAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYjuQWijPPoC35yBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAvrwgDgkLCBELqBEJqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAxc3PWY8CLY8WI7kFoozz6At9nyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjIwMDAwMDAwMAAfQ7Z1v+eBAKO6gQAAgPACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4A/gCDU0YAP7+Rer/2Dpgy5/ivf+1oDg1X+jcABxTu2uRu4+zgQC3iveBAfGCAabwgQM=', 'base64');
const BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNkYPjPwMDAxMAAAA0GAQOqgnhHAAAAAElFTkSuQmCC', 'base64');

/** webhook-retries' scratch folder, as the first test found it (its Show in Finder names it only while the folder is empty). */
let retriesDir: string | undefined;

test('Scratch: .beluga/scratch/ live, newest first, followed by the preview', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /webhook-retries/);

  await page.keyboard.press('Meta+Alt+6');
  await expect(tab(page, 'Scratch')).toHaveAttribute('aria-selected', 'true');
  const finder = panel(page).getByRole('button', { name: 'Show in Finder' });
  await expect(finder).toBeVisible();
  const dir = (await finder.getAttribute('title'))!;
  expect(dir).toMatch(/\/\.beluga\/scratch$/);
  retriesDir = dir;

  // Claude writes a JSON response: it shows up, laid out.
  writeFileSync(path.join(dir, 'api-response.json'), '{"ok":true,"items":[1,2]}');
  const files = panel(page).getByRole('listbox', { name: 'Scratch files' });
  await expect(files.getByRole('option', { name: /api-response\.json/ })).toBeVisible();
  const json = panel(page).getByRole('region', { name: 'api-response.json' });
  await expect(json).toContainText('"items": [');

  // Then a screenshot, in a folder: it's on top and the preview follows it.
  mkdirSync(path.join(dir, 'shots'), { recursive: true });
  writeFileSync(path.join(dir, 'shots', 'home.png'), RED);
  await expect(files.getByRole('option').first()).toContainText('home.png');
  const shot = panel(page).getByRole('region', { name: 'home.png' }).locator('img');
  await expect(shot).toBeVisible();
  const before = await shot.getAttribute('src');
  // Written again: the picture is read again.
  writeFileSync(path.join(dir, 'shots', 'home.png'), BLUE);
  await expect.poll(() => shot.getAttribute('src')).not.toBe(before);

  // Picking the older one stays on it while new files arrive.
  await files.getByRole('option', { name: /api-response\.json/ }).click();
  writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nStill on it.');
  await expect(files.getByRole('option').first()).toContainText('notes.md');
  await expect(panel(page).getByRole('region', { name: 'api-response.json' })).toBeVisible();
  await files.getByRole('option', { name: /notes\.md/ }).click();
  await expect(panel(page).getByRole('region', { name: 'notes.md' }).getByRole('heading', { name: 'Notes' })).toBeVisible();

  // A log that grows: scrolled to its end, it follows what's written to it, in place.
  const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}`).join('\n');
  writeFileSync(path.join(dir, 'run.log'), lines(200));
  await files.getByRole('option', { name: /run\.log/ }).click();
  const log = panel(page).getByRole('region', { name: 'run.log' });
  await expect(log).toContainText('line 200');
  const follow = log.getByRole('button', { name: 'Follow the End' });
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  const view = log.locator('.selectable').first();
  const gap = () => view.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await view.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await log.locator('pre').evaluate((el) => el.setAttribute('data-was', 'here'));
  writeFileSync(path.join(dir, 'run.log'), lines(260));
  await expect(log).toContainText('line 260');
  // Updated in place: the same drawing, not one drawn anew (no flash).
  await expect(log.locator('pre')).toHaveAttribute('data-was', 'here');
  await expect.poll(gap).toBeLessThan(10);
  await panel(page).screenshot({ path: path.join(SHOTS, 'scratch-follow.png') });

  // Scrolled up, it stays where you are; the button jumps back to the end and follows again.
  await view.evaluate((el) => (el.scrollTop = 0));
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  writeFileSync(path.join(dir, 'run.log'), lines(300));
  await expect(log).toContainText('line 300');
  expect(await view.evaluate((el) => el.scrollTop)).toBe(0);
  await follow.click();
  await expect.poll(gap).toBeLessThan(10);
  await expect(follow).toHaveAttribute('aria-pressed', 'true');

  // A PDF shows its pages, a video plays, and a file with no preview says so (BLG-96).
  writeFileSync(path.join(dir, 'brief.pdf'), demoPdf());
  await files.getByRole('option', { name: /brief\.pdf/ }).click();
  await expect(panel(page).getByRole('region', { name: 'brief.pdf' }).getByRole('img', { name: 'Page 1' })).toBeVisible();
  writeFileSync(path.join(dir, 'run.webm'), CLIP);
  await files.getByRole('option', { name: /run\.webm/ }).click();
  await expect(panel(page).getByRole('region', { name: 'run.webm' }).locator('video')).toBeVisible();
  writeFileSync(path.join(dir, 'trace.bin'), Buffer.from([0, 1, 2, 0, 3]));
  await files.getByRole('option', { name: /trace\.bin/ }).click();
  await expect(panel(page).getByRole('region', { name: 'trace.bin' })).toContainText('No preview for this kind of file');
  await panel(page).screenshot({ path: path.join(SHOTS, 'scratch-no-preview.png') });
});

const SHOTS = path.resolve(import.meta.dirname, '../../../.context/shots');

test('Scratch: a calm empty state before anything lands, saying when Claude works; .context/ files show too', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await expect(composer(page)).toHaveAttribute('placeholder', /add-auth/);
  await page.keyboard.press('Meta+Alt+6');
  await expect(tab(page, 'Scratch')).toHaveAttribute('aria-selected', 'true');

  // Nothing yet, Claude idle: a calm empty state (not a loading outline), no list of folder paths.
  await expect(panel(page).getByText('Nothing in scratch yet')).toBeVisible();
  await expect(panel(page)).not.toContainText('.beluga/scratch/');
  await panel(page).screenshot({ path: path.join(SHOTS, 'scratch-idle.png') });

  // Claude starts: the empty state says so.
  await composer(page).fill('Take a screenshot of the login page');
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('status').filter({ hasText: 'Your agent is working' })).toBeVisible();
  await panel(page).screenshot({ path: path.join(SHOTS, 'scratch-working.png') });

  // A file lands in .context/ (another tool's folder Claude was told to use): it shows, tagged.
  const dir = (await panel(page).getByRole('button', { name: 'Show in Finder' }).getAttribute('title'))!;
  const root = path.dirname(path.dirname(dir));
  mkdirSync(path.join(root, '.context'), { recursive: true });
  writeFileSync(path.join(root, '.context', 'login.png'), RED);
  const files = panel(page).getByRole('listbox', { name: 'Scratch files' });
  const shot = files.getByRole('option', { name: /login\.png/ });
  await expect(shot).toBeVisible();
  await expect(shot).toContainText('.context');
  await page.waitForTimeout(400); // the screenshot's: its thumbnail fades in
  await panel(page).screenshot({ path: path.join(SHOTS, 'scratch-context-file.png') });

  // Claude works again: a row on top of the list says so, where the next file will land.
  await composer(page).fill('And the signup page');
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('status').filter({ hasText: 'Your agent is working' })).toBeVisible();
  await panel(page).screenshot({ path: path.join(SHOTS, 'scratch-list-working.png') });
});

test('Scratch: viewable files first, a web page drawn in a sandbox, and ← → through what can be looked at, full size (BLG-111)', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page).getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'webhook-retries', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await row.click();
  await page.keyboard.press('Meta+Alt+6');
  test.skip(!retriesDir, 'needs the first test’s folder (run the whole file)');
  const sub = path.join(retriesDir!, 'blg111');
  mkdirSync(sub, { recursive: true });
  // Newer than anything else here (the files above are in this folder too), oldest first: a picture, notes, a web page (whose script must not run), JSON, a picture, a log (the newest).
  const files: [string, string | Buffer][] = [
    ['b111-first.png', RED],
    ['b111-notes.md', '# Notes'],
    ['b111-report.html', '<!doctype html><h1 id="t">Report OK</h1><script>document.getElementById("t").textContent = "script ran"</script>'],
    ['b111-data.json', '{"a":1}'],
    ['b111-last.png', BLUE],
    ['b111-run.log', 'hello'],
  ];
  const t0 = Date.now() / 1000 + 60;
  files.forEach(([name, body], i) => {
    writeFileSync(path.join(sub, name), body);
    utimesSync(path.join(sub, name), t0 + i, t0 + i);
  });
  const list = panel(page).getByRole('listbox', { name: 'Scratch files' });
  await expect(list.getByRole('option').first()).toContainText('b111-run.log');
  const order = async () => (await list.getByRole('option').allTextContents()).map((t) => /^b111-([\w.]+?\.(?:png|md|html|json|log))/.exec(t)?.[1]).filter(Boolean);
  expect(await order()).toEqual(['run.log', 'last.png', 'data.json', 'report.html', 'notes.md', 'first.png']);

  // The sort menu: what can be looked at first, each part still newest first.
  await panel(page).getByRole('button', { name: 'Sorted: newest first' }).click();
  await page.getByRole('menuitem', { name: /Viewable First/ }).click();
  await expect(panel(page).getByRole('button', { name: 'Sorted: viewable first' })).toBeVisible();
  await expect(list.getByRole('option').first()).toContainText('b111-last.png');
  expect(await order()).toEqual(['last.png', 'report.html', 'first.png', 'run.log', 'data.json', 'notes.md']);

  // A web page is drawn, sandboxed with nothing allowed: its script didn't run.
  await list.getByRole('option', { name: /b111-report\.html/ }).click();
  const frame = panel(page).getByRole('region', { name: 'b111-report.html' }).locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame.contentFrame().locator('h1')).toHaveText('Report OK');

  // Full size from the newest picture (the top of the list): → goes down this order, ← back up, and
  // stops at the top (no wrapping round to the bottom).
  await list.getByRole('option', { name: /b111-last\.png/ }).click();
  await panel(page).getByRole('region', { name: 'b111-last.png' }).getByRole('button', { name: 'Open in full' }).click();
  const where = page.getByRole('main').getByRole('navigation', { name: 'Path' });
  await expect(where).toContainText('b111-last.png');
  for (const [key, name] of [['ArrowRight', 'b111-report.html'], ['ArrowRight', 'b111-first.png'], ['ArrowLeft', 'b111-report.html'], ['ArrowLeft', 'b111-last.png'], ['ArrowLeft', 'b111-last.png']] as const) {
    await page.keyboard.press(key);
    await expect(where).toContainText(name);
    if (name === 'b111-report.html') await expect(page.getByRole('main').locator('iframe')).toBeVisible();
  }
});

/** Your Mac's chat has its own Scratch (BLG-704): the folder all its chats share, and how much it holds. */
test('Scratch beside Your Mac: its folder, live, with how much it holds, and a picture that opens', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByText('Your Mac', { exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Your Mac’s chats' })).toBeVisible();
  if (!(await tab(page, 'Scratch').isVisible())) await page.keyboard.press('Meta+Alt+0');
  await tab(page, 'Scratch').click();
  await expect(tab(page, 'Scratch')).toHaveAttribute('aria-selected', 'true');
  const finder = panel(page).getByRole('button', { name: 'Show in Finder' });
  await expect(finder).toBeVisible();
  const dir = (await finder.getAttribute('title'))!;
  expect(dir).toMatch(/\/work\/\.beluga\/scratch$/);

  mkdirSync(path.join(dir, 'screens'), { recursive: true });
  writeFileSync(path.join(dir, 'screens', 'desktop.png'), RED);
  writeFileSync(path.join(dir, 'cpu.txt'), 'x'.repeat(4096));
  const files = panel(page).getByRole('listbox', { name: 'Scratch files' });
  await expect(files.getByRole('option')).toHaveCount(2);
  await expect(panel(page).getByText('2 files', { exact: true })).toBeVisible();
  // How much it holds, beside the count (not each row's size).
  await expect(panel(page).getByText('2 files', { exact: true }).locator('..')).toContainText('4 KB');
  await files.getByRole('option', { name: /desktop\.png/ }).click();
  await expect(panel(page).getByRole('region', { name: 'desktop.png' }).locator('img')).toBeVisible();
  await page.screenshot({ path: '../../.beluga/scratch/01-your-mac-scratch.png' });
});
