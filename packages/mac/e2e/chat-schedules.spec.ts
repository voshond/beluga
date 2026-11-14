import path from 'node:path';
import { SocketClient } from '../../../src/ipc/socket-client.js';
import { withExperiment } from '../../../src/shared/experiments.js';
import { expect, test, type Page } from './fixtures.js';

/**
 * Chat schedules (plan "Chat schedules on Sentinel", BLG-399…401): a chat's Info panel lists the
 * sentinels that wake it, with Run Now and an on/off switch; the section hides with the
 * chat-schedules experiment off; /schedule makes one; a scheduled chat's row has a clock mark. Screenshots go to .beluga/scratch/chat-schedules-*.png.
 */

const shots = path.join(import.meta.dirname, '..', '..', '..', '.beluga', 'scratch');
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const CHAT = 'Daily status';

/** A picture for the proof, with the terminal masked: its prompt is the real shell's, with personal data. */
const shoot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `chat-schedules-${name}.png`), mask: [page.locator('.xterm')] });

type Demo = { readonly endpoint: { readonly url: string; readonly token: string } };
const connect = (demo: Demo) => SocketClient.connect({ url: demo.endpoint.url, token: demo.endpoint.token, kind: 'test', version: 'e2e' });

/** A chat in bob-api with one schedule that wakes it every day at 9:00 (made through the API, as the agent would). */
async function seed(demo: Demo): Promise<void> {
  const client = await connect(demo);
  await client.api.session.setPrefs({ experiments: ['chat-schedules'], folded: [] });
  const state = client.store.getState();
  const project = state.projects.find((p) => p.name === 'bob-api')!.id;
  const ws = (await client.api.workspaces.newChat(project, CHAT)) as string;
  const made = (await client.api.sentinel.create({ name: 'Morning status', trigger: { kind: 'schedule', every: 'day', at: '09:00', missed: 'skip' }, steps: [{ kind: 'chat', to: `${client.store.getState().selfId}/ws:${ws}`, text: 'Send XYZ' }] } as never)) as { id: string };
  await client.api.sentinel.pause(made.id, false);
  client.close();
}

async function openChat(page: Page): Promise<void> {
  await page.goto('/');
  // The demo's project starts folded.
  const show = sidebar(page).getByRole('button', { name: "Show what's in bob-api" }).first();
  await show.click();
  await sidebar(page).getByRole('button', { name: new RegExp(`^${CHAT}`) }).first().click();
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test('the Info panel lists the chat’s schedule; Run Now runs it and the switch turns it off', async ({ page, demo }) => {
  test.setTimeout(90_000);
  await seed(demo);
  await openChat(page);
  const row = inspector(page).locator('[data-schedule]');
  await expect(row).toHaveCount(1, { timeout: 20_000 });
  await expect(row).toContainText('Morning status');
  await expect(row).toContainText(/Every day at 9:00 · next/);
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  // The chat's row in the sidebar has the clock mark.
  await expect(sidebar(page).locator('[data-scheduled="on"]')).toHaveCount(1);
  await shoot(page, '01-info');

  await row.getByRole('button', { name: 'Run Morning status now' }).click();
  await expect(page.getByText('Morning status is running')).toBeVisible();

  await row.getByRole('switch').click();
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(row).toContainText('Every day at 9:00 · paused');
  await expect(sidebar(page).locator('[data-scheduled="off"]')).toHaveCount(1);
  await shoot(page, '02-off');

  // A click on the row opens the sentinel's page.
  await row.getByRole('button', { name: /Morning status/ }).first().click();
  await expect(page.locator('main').getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Morning status');
});

test('/schedule opens the sheet; In hours makes a once schedule that starts on and shows at once', async ({ page }) => {
  test.setTimeout(90_000);
  await openChat(page);
  await page.locator('textarea:not(.xterm-helper-textarea)').fill('/schedule Check the build');
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Schedule a Message' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Check the build');
  await sheet.getByRole('radio', { name: 'In hours' }).click();
  await sheet.getByRole('textbox', { name: 'In how many hours' }).fill('2');
  await shoot(page, '03-sheet');
  await sheet.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(sheet).toBeHidden();
  const row = inspector(page).locator('[data-schedule]').filter({ hasText: 'Check the build' });
  await expect(row).toContainText(/Once, .* · next/);
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await shoot(page, '04-made');
});

test('with the experiment off, the section is hidden', async ({ page, demo }) => {
  const client = await connect(demo);
  await client.api.session.setPrefs({ experiments: withExperiment([], 'chat-schedules', false) });
  client.close();
  await openChat(page);
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).locator('[data-schedule]')).toHaveCount(0);
  await expect(inspector(page).getByRole('heading', { name: /^Schedules/ })).toHaveCount(0);
  await expect(sidebar(page).locator('[data-scheduled]')).toHaveCount(0);
});
