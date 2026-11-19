import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * A pasted JPEG, WebP or GIF goes as it is, its own bytes and type (BLG-109): never an empty
 * "image.png" (WebKitGTK's paste), never converted. One picture offered several ways goes once.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page: Page) => page.locator('main textarea:not(.xterm-helper-textarea)').last();

const IMAGES = {
  'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==',
  'image/jpeg':
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z',
  'image/webp': 'UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoEAAQAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA',
  // Two frames, red then green: it stays animated only if these bytes go as they are.
  'image/gif': 'R0lGODlhBAAEAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAABAAEAAACBISPCQUAIfkEABQAAAAsAAAAAAQABACAAP8AAAAAAgSEjwkFADs=',
} as const;
type Mime = keyof typeof IMAGES;

/** What the box asked Beluga to keep: [extension, base64] per `attachments.add`. */
const watchAdds = async (page: Page): Promise<Array<[string, string]>> => {
  const adds: Array<[string, string]> = [];
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = typeof message === 'string' && message.startsWith('{') ? (JSON.parse(message) as { t?: string; method?: string; args?: [string, string] }) : undefined;
      if (frame?.t === 'call' && frame.method === 'attachments.add' && frame.args) adds.push(frame.args);
      server.send(message);
    });
  });
  return adds;
};

/** A paste the way a web view hands it over: each picture a file, `empty` ones with no bytes (WebKitGTK's for a JPEG). */
const paste = (box: Locator, files: ReadonlyArray<{ type: string; b64: string; name?: string }>) =>
  box.evaluate((el, list) => {
    const data = new DataTransfer();
    for (const f of list) data.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name ?? `image.${f.type.split('/')[1]}`, { type: f.type }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, files);

const openGroupChat = async (page: Page): Promise<Locator> => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'Group chat' }).click();
  const box = composer(page);
  await box.fill('');
  await box.focus();
  return box;
};

const tray = (page: Page) => page.getByRole('group', { name: 'Images to send' }).last();

for (const mime of ['image/jpeg', 'image/webp', 'image/gif', 'image/png'] as const) {
  test(`a pasted ${mime} goes with its own bytes and type`, async ({ page }) => {
    const adds = await watchAdds(page);
    const box = await openGroupChat(page);
    await paste(box, [{ type: mime, b64: IMAGES[mime] }]);
    await expect.poll(() => adds.length).toBe(1);
    expect(adds[0]![0]).toBe(mime.split('/')[1]);
    expect(adds[0]![1]).toBe(IMAGES[mime]);
    await expect(box).toHaveValue(/\[(?:image \d+|\d+[  ][^\]\n]+)\] $/);
    await expect(tray(page).locator('img')).toHaveCount(1);
    await expect(tray(page).locator('img')).toHaveJSProperty('complete', true);
  });
}

test('one picture offered as JPEG, PNG and WebP goes once, as its PNG', async ({ page }) => {
  const adds = await watchAdds(page);
  const box = await openGroupChat(page);
  await paste(box, (['image/jpeg', 'image/png', 'image/webp'] as const).map((type) => ({ type, b64: IMAGES[type] })));
  await expect.poll(() => adds.length).toBe(1);
  expect(adds[0]).toEqual(['png', IMAGES['image/png']]);
  await page.waitForTimeout(300);
  expect(adds).toHaveLength(1);
  await expect(tray(page).locator('img')).toHaveCount(1);
});

test('in the Linux app, a JPEG WebKitGTK pastes as an empty image.png is read from the clipboard as it is', async ({ page }) => {
  const adds = await watchAdds(page);
  const box = await openGroupChat(page);
  // The app's shell, from here on: GTK's clipboard offers the JPEG (and only that).
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const calls: string[] = [];
    Object.assign(globalThis, {
      __pasteCalls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (cmd: string, args: { mime?: string }) => {
          const name = cmd.replace(/^plugin:beluga\|/, '');
          calls.push(args?.mime ? `${name} ${args.mime}` : name);
          if (name === 'clipboard_image_types') return ['image/jpeg'];
          if (name === 'clipboard_image' && args.mime === 'image/jpeg') return bytes.buffer;
          throw `unknown command ${cmd}`;
        },
      },
    });
  }, IMAGES['image/jpeg']);
  await paste(box, [{ type: 'image/png', b64: '' }]);
  await expect.poll(() => adds.length).toBe(1);
  expect(adds[0]).toEqual(['jpeg', IMAGES['image/jpeg']]);
  expect(await page.evaluate(() => (globalThis as unknown as { __pasteCalls: string[] }).__pasteCalls)).toEqual(['clipboard_image_types', 'clipboard_image image/jpeg']);
  await page.evaluate(() => delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  await expect(tray(page).locator('img')).toHaveCount(1);
});
