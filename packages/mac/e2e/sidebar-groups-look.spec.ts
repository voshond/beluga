import { expect, test, type Locator } from './fixtures.js';

/**
 * A group in the sidebar is a sibling of the projects around it, not their parent: a group's row and
 * a project's row start in the same column, and only the group's own projects step in. Its icon is
 * yours to pick (Change Icon ▸), and it stays through a rename.
 */

const left = async (l: Locator): Promise<number> => (await l.boundingBox())?.x ?? -1;

test('groups line up with projects, and wear the icon you pick', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByRole('button', { name: 'bob-api' }).first()).toBeVisible();
  await sidebar.getByRole('button', { name: 'landing', exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to Group' }).click();
  await page.getByRole('menuitem', { name: 'New Group…' }).click();
  const field = sidebar.getByRole('textbox', { name: 'Name of the new group for landing' });
  await expect(field).toBeFocused();
  await field.fill('Look Group');
  await field.press('Enter');
  const group = sidebar.getByRole('button', { name: 'Group Look Group' });
  await expect(group).toBeVisible();

  // The group's triangle and a top-level project's triangle are in one column; its project steps in.
  const groupTriangle = group.locator('svg').first();
  const topTriangle = sidebar.getByRole('button', { name: /^Fold bob-api|^Show what's in bob-api/ }).first().locator('svg');
  const innerTriangle = sidebar.getByRole('button', { name: /^Fold landing|^Show what's in landing/ }).locator('svg');
  expect(Math.abs((await left(groupTriangle)) - (await left(topTriangle)))).toBeLessThan(2);
  expect((await left(innerTriangle)) - (await left(topTriangle))).toBeGreaterThan(8);
  // And so do the folder and the project's icon after them.
  const groupIcon = group.locator('svg').nth(1);
  const topIcon = sidebar.getByRole('button', { name: 'bob-api', exact: true }).first().locator('[class*="projectIcon"] > :last-child');
  expect(Math.abs((await left(groupIcon)) - (await left(topIcon)))).toBeLessThan(2);

  // Change Icon ▸ Globe, kept through a rename.
  await group.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Change Icon' }).click();
  await page.getByRole('menuitem', { name: 'Globe' }).click();
  await group.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Change Icon' }).click();
  await expect(page.getByRole('menuitem', { name: 'Globe' })).toHaveAttribute('data-checked', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await group.dblclick();
  const rename = sidebar.getByRole('textbox', { name: 'New name for the group Look Group' });
  await rename.fill('Renamed Group');
  await rename.press('Enter');
  const renamed = sidebar.getByRole('button', { name: 'Group Renamed Group' });
  await expect(renamed).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('beluga.prefs.v1') ?? '{}').groupIcons)).toEqual({ 'Renamed Group': 'globe' });
  // Put things back for the other tests.
  await renamed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Ungroup' }).click();
  await expect(renamed).toHaveCount(0);
});
