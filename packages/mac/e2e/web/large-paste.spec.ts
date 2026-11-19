import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { type Served, startServed } from './served.js';

/**
 * A big picture pasted on a served page (BLG-110), as the Linux thin client loads it: an 18 MB,
 * 12-megapixel PNG attaches without dropping the page's socket or stalling it, its chip shows a
 * small copy, and the file Beluga keeps comes from the untouched original.
 */

test.describe.configure({ mode: 'serial' });

let web: Served;
let big: Buffer;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  big = noisyPng(3024, 4032);
  web = await startServed();
});
test.afterAll(async () => web?.stop());

/** A photo-sized PNG that barely compresses, so it's as big on disk as a real one. */
function noisyPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  const noise = randomBytes(width * height * 4);
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 64 + (noise[i]! & 15);
    png.data[i + 1] = 96 + (noise[i + 1]! & 15);
    png.data[i + 2] = 128 + (noise[i + 2]! & 15);
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png, { colorType: 2 });
}

const settled = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    localStorage.setItem('beluga.onboarding.v1', JSON.stringify({ version: 'e2e', at: 0, how: 'finished' }));
    localStorage.setItem('beluga.tasks.v2', JSON.stringify({ display: 'list' }));
  });
};

/** Every socket the page closes or loses, by its close code; and the longest the page went without drawing. */
const watchPage = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const w = window as unknown as { __closes: number[]; __gap: number; __watching: boolean };
    w.__closes = [];
    w.__gap = 0;
    w.__watching = false;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('close', (e) => w.__closes.push(e.code));
      }
    };
    let last = performance.now();
    const tick = (now: number): void => {
      if (w.__watching) w.__gap = Math.max(w.__gap, now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
};

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();

const pasteBig = async (page: Page, bytes: Buffer, name = 'image.png'): Promise<void> => {
  await page.route('**/__e2e/big.png', (route) => route.fulfill({ body: bytes, contentType: 'image/png' }));
  await composer(page).evaluate(async (el, file) => {
    const blob = await (await fetch('/__e2e/big.png')).blob();
    const w = window as unknown as { __watching: boolean; __gap: number };
    w.__gap = 0;
    w.__watching = true;
    const data = new DataTransfer();
    data.items.add(new File([blob], file, { type: 'image/png' }));
    (el as HTMLTextAreaElement).focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, name);
};

test('an 18 MB, 12 MP PNG pasted on a served page attaches without dropping the socket or stalling', async ({ page }) => {
  test.setTimeout(120_000);
  await settled(page);
  await watchPage(page);
  await page.goto(web.link);
  await expect(sidebar(page)).toBeVisible({ timeout: 30_000 });
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await expect(composer(page)).toBeVisible();
  await composer(page).fill('');

  await pasteBig(page, big);

  const images = page.getByRole('group', { name: 'Images to send' });
  await expect(images.getByRole('button', { name: /Open image/ })).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  const chip = images.locator('img');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  const shown = await chip.evaluate((el: HTMLImageElement) => ({ w: el.naturalWidth, h: el.naturalHeight }));
  expect(Math.max(shown.w, shown.h)).toBeLessThanOrEqual(2048);

  const watched = await page.evaluate(() => {
    const w = window as unknown as { __closes: number[]; __gap: number; __watching: boolean };
    w.__watching = false;
    return { closes: w.__closes, gap: w.__gap };
  });
  expect(watched.closes).toEqual([]);
  expect(watched.gap).toBeLessThan(1500);
  await expect(page.getByText(/Couldn.t add/)).toHaveCount(0);

  // What went to the server is the file as it was pasted, byte for byte.
  const uploads = path.join(web.home, 'uploads');
  const sent = readdirSync(uploads, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('image.png'));
  expect(sent).toHaveLength(1);
  expect(readFileSync(path.join(uploads, sent[0]!)).equals(big)).toBe(true);

  // The lightbox shows the same small copy.
  await images.getByRole('button', { name: /Open image/ }).click();
  const full = page.locator('img[class*="full"]');
  await expect(full).toBeVisible();
  const opened = await full.evaluate((el: HTMLImageElement) => Math.max(el.naturalWidth, el.naturalHeight));
  expect(opened).toBeGreaterThan(0);
  expect(opened).toBeLessThanOrEqual(2048);
});

test('an absurdly big picture is refused with a clear message, not attached', async ({ page }) => {
  await settled(page);
  await page.goto(/(http:\/\/\S+\/join#\S+)/.exec(await web.cli())![1]!);
  await expect(sidebar(page)).toBeVisible({ timeout: 30_000 });
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  await composer(page).evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(101 * 1024 * 1024)], 'huge.png', { type: 'image/png' }));
    (el as HTMLTextAreaElement).focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.getByText(/too big to attach/)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Images to send' })).toHaveCount(0);
});
