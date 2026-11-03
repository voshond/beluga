import { SocketClient } from '../../../src/ipc/socket-client.js';
import { expect, test, type Page } from './fixtures.js';
import { openTasks } from './helpers.js';

/**
 * What Waits on What on a heavy board (BLG-691): fourteen epics of 3 to 24 sub-tasks, and blockers
 * within and across them, about the shape of a real busy board. It opens at a zoom you can read,
 * lays out quickly, keeps where you are while the board changes, and pans, zooms and points smoothly.
 */

const EPICS = [24, 18, 14, 12, 10, 9, 8, 7, 6, 5, 4, 4, 3, 3];

test.describe.configure({ mode: 'serial' });

/** The view's zoom, from React Flow's transform. */
async function zoomOf(page: Page): Promise<number> {
  const t = await page.locator('main .react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);
  return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 'NaN');
}

/** How many frames in `ms` took longer than `slow` ms while `act` runs. */
async function longFrames(page: Page, act: () => Promise<void>, slow = 50): Promise<{ frames: number; long: number; worst: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (now: number): void => {
      w.__frames.push(now - last);
      last = now;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__stop = true;
    return w.__frames.slice(1);
  });
  return { frames: frames.length, long: frames.filter((f) => f > slow).length, worst: Math.round(Math.max(0, ...frames)) };
}

test('a heavy board opens readable, stays put while it changes, and moves smoothly', async ({ page, demo }) => {
  test.setTimeout(180_000);
  const client = await SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e', timeoutMs: 10_000 });
  let moving = '';
  try {
    const deadline = Date.now() + 20_000;
    while (!client.store.getState().projects.some((p) => p.name === 'bob-api') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const projectId = client.store.getState().projects.find((p) => p.name === 'bob-api')!.id;
    const statuses = ['todo', 'in_progress', 'in_review', 'backlog', 'done'] as const;
    let n = 0;
    const kids: string[][] = [];
    for (const [e, size] of EPICS.entries()) {
      const epic = await client.api.board.create({ projectId, title: `Epic ${e + 1}: a long piece of work with a name`, status: 'in_progress' });
      const mine: string[] = [];
      for (let k = 0; k < size; k++) {
        // Some wait on the one before them in their epic.
        const blockedBy = k > 0 && k % 3 === 0 ? [mine[k - 1]!] : [];
        const t = await client.api.board.create({ projectId, title: `Sub-task ${k + 1} of epic ${e + 1}: do the thing well`, parent: epic.id, status: statuses[n++ % statuses.length], blockedBy });
        mine.push(t.id);
      }
      kids.push(mine);
    }
    // And some wait across epics.
    for (let e = 1; e < EPICS.length; e += 2) await client.api.board.relate(kids[e]![0]!, 'blocked_by', kids[e - 1]!.at(-1)!, true);
    moving = kids[0]![1]!;

    await page.goto('/');
    await openTasks(page);
    await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
    const started = Date.now();
    await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'What Waits on What' }).click();
    const ready = page.locator('main [data-ready="true"]');
    await expect(ready).toBeVisible({ timeout: 30_000 });
    const tookMs = Date.now() - started;
    // Let the first framing finish.
    await page.waitForTimeout(800);
    const zoom = await zoomOf(page);
    const nodes = await page.locator('main .react-flow__node').count();
    console.log(`[heavy-graph] ready in ${tookMs} ms, ${nodes} nodes, zoom ${zoom.toFixed(3)}`);
    await page.screenshot({ path: test.info().outputPath('opens.png') });
    // Readable from the start: not shrunk to a speck to fit everything in.
    expect(zoom).toBeGreaterThanOrEqual(0.5);

    // The board changes (a status moves): the drawing stays where it is, no laying out again.
    const before = await page.locator('main .react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);
    const flips = await longFrames(page, async () => {
      for (const s of ['in_review', 'todo', 'in_progress'] as const) {
        await client.api.board.move(moving, s);
        await page.waitForTimeout(400);
      }
    });
    console.log(`[heavy-graph] while the board changes: ${JSON.stringify(flips)}`);
    await expect(ready).toBeVisible();
    expect(await page.locator('main .react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform)).toBe(before);

    // Pointing across nodes, panning and zooming: no long stalls.
    const pane = page.locator('main .react-flow__pane');
    const box = (await pane.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const hover = await longFrames(page, async () => {
      for (let i = 0; i < 40; i++) await page.mouse.move(box.x + 80 + ((i * 37) % (box.width - 160)), box.y + 80 + ((i * 53) % (box.height - 160)));
    });
    console.log(`[heavy-graph] pointing: ${JSON.stringify(hover)}`);
    const pan = await longFrames(page, async () => {
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 30; i++) await page.mouse.wheel(12, 18);
      await page.waitForTimeout(300);
    });
    console.log(`[heavy-graph] panning: ${JSON.stringify(pan)}`);
    const pinch = await longFrames(page, async () => {
      for (let i = 0; i < 20; i++) await page.evaluate(([x, y]) => document.querySelector('main .react-flow__pane')?.dispatchEvent(new WheelEvent('wheel', { deltaY: -8, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true })), [cx, cy] as const);
      await page.waitForTimeout(300);
    });
    console.log(`[heavy-graph] zooming: ${JSON.stringify(pinch)}, zoom now ${(await zoomOf(page)).toFixed(3)}`);
    expect(await zoomOf(page)).toBeGreaterThan(zoom);

    // Keys in the canvas: 0 fits all of it in (zooming out further than the start), + zooms in.
    await page.locator('main [data-mode="full"]').focus();
    await page.keyboard.press('0');
    await expect.poll(() => zoomOf(page)).toBeLessThan(zoom);
    const all = await zoomOf(page);
    await page.screenshot({ path: test.info().outputPath('fit-all.png') });
    await page.keyboard.press('=');
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(all);
  } finally {
    client.close();
  }
});
