import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeImage } from '../../../src/image/decode.js';
import { expect, test, type Page } from './fixtures.js';
import { openPlansList } from './helpers.js';

/**
 * Images a message shows by their path on this Mac (`![shot](</Users/…/shot.png>)`, the way Claude
 * shows a screenshot it took): thumbnails like pasted images, a row of them, and the lightbox.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('textarea:not(.xterm-helper-textarea)');

// A 2×2 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==', 'base64');

test('a message’s local screenshots show as thumbnails that open full size', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga e2e shots-'));
  writeFileSync(path.join(dir, 'first.png'), PNG);
  writeFileSync(path.join(dir, 'second.png'), PNG);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await composer(page).fill(`Here they are:\n\n![First shot](<${dir}/first.png>)\n![](${dir.replace(/ /g, '%20')}/second.png)\n\nand a [web one](https://example.com) ![logo](https://example.com/logo.png)`);
  await composer(page).press('Enter');

  const first = page.getByRole('button', { name: 'Open First shot' }).last();
  await expect(first).toBeVisible();
  await expect(first.locator('img')).toHaveJSProperty('complete', true);
  await expect(page.getByRole('button', { name: 'Open second.png' }).last()).toBeVisible();
  // A web image is a chip that opens in the browser (the window loads only what Beluga reads).
  await expect(page.getByRole('link', { name: 'logo' }).last()).toBeVisible();

  await first.click();
  const box = page.getByRole('dialog');
  await expect(box).toContainText('First shot');
  await expect(box).toContainText('1 of 2');
  // A pinch zooms the picture in the lightbox (as WebKit reports it).
  const shown = box.locator('img');
  // Centered both ways in the space it has (BLG-112).
  await expect
    .poll(() => shown.evaluate((el) => { const s = el.parentElement!.getBoundingClientRect(); const b = el.getBoundingClientRect(); return Math.round(Math.abs(b.left + b.width / 2 - (s.left + s.width / 2)) + Math.abs(b.top + b.height / 2 - (s.top + s.height / 2))); }))
    .toBeLessThanOrEqual(1);
  const before = (await shown.boundingBox())!.width;
  await shown.evaluate((el) => {
    const fire = (type: string, scale: number) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: 400, clientY: 300 }));
    fire('gesturestart', 1);
    fire('gesturechange', 2.5);
  });
  await expect.poll(async () => (await shown.boundingBox())!.width).toBeGreaterThan(before * 1.5);
  await page.keyboard.press('ArrowRight');
  await expect(box).toContainText('second.png');
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
});

// 24×24, pink then blue, looping (an animation Claude made, shown the way it shows a screenshot: BLG-182).
const GIF = Buffer.from('R0lGODlhGAAYAIAAAOVzc2S19iH/C05FVFNDQVBFMi4wAwEAAAAh+QQADwAAACwAAAAAGAAYAAACFoSPqcvtD6OctNqLs968+w+G4kiWUwEAIfkEAA8AAAAsAAAAABgAGAAAAhaMj6nL7Q+jnLTai7PevPsPhuJIllMBADs=', 'base64');

test('an animated GIF a message shows plays: the file comes as it is, every frame', async ({ page }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga e2e gif-'));
  writeFileSync(path.join(dir, 'two-frames.gif'), GIF);
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await composer(page).fill(`It moves:\n\n![Two frames](<${dir}/two-frames.gif>)`);
  await composer(page).press('Enter');

  const img = page.getByRole('button', { name: 'Open Two frames' }).last().locator('img');
  await expect(img).toHaveJSProperty('complete', true);
  // Not decoded and shrunk on the way (that keeps the first frame only): the bytes on disk.
  expect(await img.evaluate(async (el: HTMLImageElement) => { const b = await (await fetch(el.src)).blob(); return [b.type, b.size]; })).toEqual(['image/gif', GIF.length]);
  // And it plays: pink, then blue, then pink again, with nobody touching it.
  const frame = async (): Promise<string> => {
    const b = decodeImage(await img.screenshot(), 'shot.png');
    const at = (Math.floor(b.height / 2) * b.width + Math.floor(b.width / 2)) * 4;
    const [r, , bl] = [b.data[at]!, b.data[at + 1]!, b.data[at + 2]!];
    // Not painted yet, it's the page behind (white): neither.
    return r > 200 && bl < 150 ? 'pink' : bl > 200 && r < 150 ? 'blue' : '-';
  };
  const seen: string[] = [];
  await expect.poll(async () => (seen.push(await frame()), seen.join(' ')), { timeout: 10_000, intervals: [50] }).toMatch(/pink.*blue.*pink|blue.*pink.*blue/);
});

test('the plan chat takes a dropped image, and shows a message’s screenshots as thumbnails, like any chat', async ({ page }) => {
  await page.goto('/');
  await openPlansList(page);
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await page.locator('main').getByRole('button', { name: /^Card checkout for launch,/ }).click();
  const chat = page.getByRole('complementary', { name: 'Conversation' });
  const box = chat.getByRole('textbox', { name: 'Message your agent about the plan' });
  await box.fill('this one:');
  // Dropped on the box: it waits as a thumbnail, referenced in the words.
  await chat.locator('form').evaluate((form, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    form.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    form.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await expect(box).toHaveValue(/^this one: \[(?:image \d+|\d+\u2007[^\]\n]+)\] $/);
  const tray = chat.getByRole('group', { name: 'Images to send' });
  await expect(tray.locator('img')).toHaveCount(1);
  await expect(tray.locator('img')).toHaveJSProperty('complete', true);
  // Nothing is sent (the demo's plan stays as it is): taking it out empties the tray.
  await chat.getByRole('button', { name: /Remove image/ }).click({ force: true });
  await expect(tray).toBeHidden();
});
