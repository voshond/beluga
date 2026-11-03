// The README's GIFs, recorded from the Mac app's web view against `vite` + a demo daemon.
//   BELUGA_URL=http://localhost:1420 node scripts/gifs.mjs [scene…]   → assets/mac/<scene>.gif
// Needs ffmpeg. Each scene is recorded as a video, then turned into a GIF with its own palette.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const repo = path.resolve(import.meta.dirname, '../../..');
const out = path.join(repo, 'assets/mac');
const tmp = path.join(repo, '.context/gifs');
const url = process.env.BELUGA_URL ?? process.env.KLAUD_URL ?? 'http://localhost:1420';
const only = process.argv.slice(2);

const side = (page) => page.getByRole('navigation', { name: 'Sidebar' });
const composer = (page) => page.locator('textarea:not(.xterm-helper-textarea)');

async function networkOn(page) {
  const card = side(page).getByRole('group', { name: 'Talk with friends' });
  if (await card.isVisible().catch(() => false)) await card.getByRole('button', { name: 'Turn On' }).click();
  await side(page).getByRole('button', { name: /^bob, / }).waitFor({ timeout: 30_000 });
}

async function say(page, text) {
  await composer(page).click();
  await page.keyboard.type(text, { delay: 45 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
}

/** A desktop behind the pop-up: kay browsing the web in Chrome, under the macOS menu bar. */
const DESKTOP = `
  html[data-popup], html[data-popup] body { background: linear-gradient(160deg, #2b3a67 0%, #4a5d9a 40%, #c0729b 100%) !important; height: 100%; }
  html[data-popup] #root { position: fixed; top: 26px; right: 0; width: 392px; z-index: 10; }
  #desk { position: fixed; inset: 0; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; color: #1f2328; }
  #desk .menubar { height: 26px; display: flex; align-items: center; gap: 18px; padding: 0 14px; background: rgba(30,30,40,.35); backdrop-filter: blur(20px); color: #fff; font-weight: 500; }
  #desk .menubar b { font-weight: 700; } #desk .menubar .right { margin-left: auto; opacity: .9; }
  #desk .win { position: absolute; left: 24px; top: 44px; right: 24px; bottom: 22px; border-radius: 11px; overflow: hidden; background: #fff; box-shadow: 0 22px 70px rgba(0,0,0,.45), 0 0 0 .5px rgba(0,0,0,.3); }
  #desk .tabs { height: 38px; background: #dee1e6; display: flex; align-items: flex-end; padding-left: 78px; gap: 2px; position: relative; }
  #desk .dots { position: absolute; left: 14px; top: 13px; display: flex; gap: 8px; } #desk .dots i { width: 12px; height: 12px; border-radius: 50%; display: block; }
  #desk .tab { height: 30px; padding: 0 14px; display: flex; align-items: center; gap: 8px; border-radius: 8px 8px 0 0; font-size: 12px; color: #3c4043; max-width: 210px; white-space: nowrap; overflow: hidden; }
  #desk .tab.on { background: #fff; } #desk .fav { width: 14px; height: 14px; border-radius: 50%; background: #1f2328; flex: none; }
  #desk .bar { height: 38px; display: flex; align-items: center; gap: 12px; padding: 0 12px; border-bottom: 1px solid #e3e3e3; }
  #desk .url { flex: 1; height: 28px; border-radius: 14px; background: #f1f3f4; display: flex; align-items: center; padding: 0 14px; color: #3c4043; font-size: 13px; }
  #desk .page { display: flex; }
  #desk .main { flex: 1; padding: 18px 26px; }
  #desk .repo { font-size: 19px; color: #0969da; } #desk .repo b { font-weight: 600; } #desk .pill { font-size: 11px; border: 1px solid #d0d7de; border-radius: 10px; padding: 1px 7px; color: #59636e; margin-left: 8px; vertical-align: 3px; }
  #desk .nav { display: flex; gap: 22px; margin: 14px 0 16px; padding-bottom: 10px; border-bottom: 1px solid #d0d7de; color: #59636e; } #desk .nav .on { color: #1f2328; font-weight: 600; box-shadow: 0 12px 0 -10px #fd8c73; }
  #desk .files { border: 1px solid #d0d7de; border-radius: 6px; width: 520px; }
  #desk .files div { display: flex; gap: 10px; padding: 7px 12px; border-top: 1px solid #d8dee4; color: #59636e; font-size: 12.5px; } #desk .files div:first-child { border-top: 0; background: #f6f8fa; color: #1f2328; }
  #desk .files span:first-child { width: 150px; color: #1f2328; }
`;

/** The page kay has open: a GitHub repository in Chrome. */
const DESKTOP_HTML = `
  <div class="menubar"><span></span><b>Chrome</b><span>File</span><span>Edit</span><span>View</span><span>History</span><span>Bookmarks</span><span class="right">Mon 12:40</span></div>
  <div class="win">
    <div class="tabs"><div class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
      <div class="tab on"><span class="fav"></span>kay/portfolio: my site</div><div class="tab">Pull requests · kay/portfolio</div><div class="tab">Vercel – Deployments</div></div>
    <div class="bar"><span>‹ ›</span><div class="url">github.com/kay/portfolio</div></div>
    <div class="page"><div class="main">
      <div class="repo">kay / <b>portfolio</b><span class="pill">Public</span></div>
      <div class="nav"><span class="on">Code</span><span>Issues 3</span><span>Pull requests 2</span><span>Actions</span><span>Settings</span></div>
      <div class="files">
        <div><span>kay</span><span>dark mode for the blog</span></div>
        <div><span>app/</span><span>pricing page</span></div>
        <div><span>components/</span><span>hero: shorter subtitle</span></div>
        <div><span>public/</span><span>og image</span></div>
        <div><span>README.md</span><span>setup notes</span></div>
        <div><span>package.json</span><span>next 15</span></div>
      </div>
    </div></div>
  </div>`;

const SCENES = {
  /** "@bob run the tests": your Claude asks bob's Claude on his Mac, and the answer comes back. */
  'ask-a-friend': {
    viewport: { width: 1280, height: 760 },
    async run(page) {
      await networkOn(page);
      await openWorkspace(page, 'webhook-retries');
      const answers = page.getByText(/^bob's Claude says/);
      const before = await answers.count();
      await say(page, '@bob run the tests in bob-api and tell me how many pass');
      await answers.nth(before).waitFor({ timeout: 60_000 });
      await page.mouse.move(560, 360);
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(3500);
    },
  },
  /** mia's Claude wants a screenshot: the pop-up on your desktop, See more, Allow. */
  'wants-to': {
    viewport: { width: 1000, height: 600 },
    async run(page, context) {
      const main = await context.newPage();
      await main.goto(url);
      await side(main).waitFor();
      await networkOn(main);
      await page.addStyleTag({ content: DESKTOP });
      await page.evaluate((html) => {
        const desk = document.createElement('div');
        desk.id = 'desk';
        desk.innerHTML = html;
        document.body.prepend(desk);
      }, DESKTOP_HTML);
      await page.bringToFront();
      await page.waitForTimeout(1500);
      await side(main).getByRole('button', { name: /^mia, / }).click();
      const box = main.getByRole('textbox', { name: 'Message mia' });
      await box.fill('can your Claude grab a screenshot from me?');
      await box.press('Enter');
      const card = page.getByTestId('request-popup-card').first();
      await card.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2600);
      await card.getByRole('button', { name: 'See more' }).hover();
      await page.waitForTimeout(500);
      await card.getByRole('button', { name: 'See more' }).click();
      await page.waitForTimeout(3800);
      await card.getByRole('button', { name: 'Allow', exact: true }).hover();
      await page.waitForTimeout(900);
      await card.getByRole('button', { name: 'Allow', exact: true }).click();
      await page.waitForTimeout(1800);
      await main.close();
    },
    path: '/popup.html',
    // Skip the wait for mia's Claude to ask.
    trim: 2.2,
  },
  /** Say what you want: a worktree of its own, named for the task, and Claude at work in it. */
  'worktree-per-task': {
    viewport: { width: 1280, height: 760 },
    async run(page) {
      await openWorkspace(page, 'add-auth');
      await say(page, 'Add rate limiting to the login endpoint and write tests');
      await page.waitForTimeout(9000);
    },
  },
  /** "show me the payments dashboard": stats, a chart and a table, live in the answer (docs/views.md). */
  views: {
    viewport: { width: 1280, height: 800 },
    async run(page) {
      await openWorkspace(page, 'webhook-retries');
      await say(page, 'show me the payments dashboard');
      const chart = page.getByRole('figure', { name: 'Chart: Payments per day' }).last();
      await chart.waitFor({ timeout: 60_000 });
      await untilIdle(page);
      await page.getByRole('figure', { name: 'Stats: Payments this week' }).last().evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      await page.waitForTimeout(2200);
      // The legend turns a series off and on.
      await chart.getByRole('button', { name: 'Wallet' }).click();
      await page.waitForTimeout(1200);
      await chart.getByRole('button', { name: 'Wallet' }).click();
      await page.waitForTimeout(1000);
      const orders = page.getByRole('figure', { name: 'Table: Latest orders' }).last();
      await orders.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      await page.waitForTimeout(1000);
      const load = orders.getByRole('button', { name: 'Load' });
      if (await load.isVisible().catch(() => false)) await load.click();
      await page.waitForTimeout(3000);
    },
  },
  /** "visualize how a payment flows": an interactive diagram Claude draws, with a walkthrough (docs/graphs.md). */
  graph: {
    viewport: { width: 1280, height: 800 },
    // Lots of moving shapes: fewer frames and colors keep it under GitHub's 10 MB.
    fps: 10,
    colors: 96,
    async run(page) {
      await openWorkspace(page, 'webhook-retries');
      await say(page, 'visualize how a payment flows through the code');
      const graph = page.getByRole('figure', { name: /^Graph: / }).last();
      await graph.waitFor({ timeout: 60_000 });
      await untilIdle(page);
      await graph.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      await page.waitForTimeout(2200);
      // Hover a node to see what it touches, then step through the walkthrough.
      const box = await graph.locator('.react-flow__node').nth(2).boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
      await page.waitForTimeout(1800);
      await graph.getByRole('button', { name: 'Walk Me Through It' }).click();
      const walk = graph.getByRole('region', { name: 'Walkthrough' });
      for (let i = 0; i < 3; i++) {
        await page.waitForTimeout(1800);
        await walk.getByRole('button', { name: 'Next' }).click();
      }
      await page.waitForTimeout(2200);
    },
  },
  /** Tasks in the answer, live, then the project's board (docs/tasks-and-plans.md). */
  tasks: {
    viewport: { width: 1280, height: 800 },
    async run(page) {
      await openWorkspace(page, 'webhook-retries');
      await say(page, 'where do my tasks stand?');
      await page.getByRole('list', { name: '5 tasks' }).last().waitFor({ timeout: 60_000 });
      await untilIdle(page);
      await page.mouse.move(640, 400);
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(2600);
      await side(page).getByRole('button', { name: /^Tasks/ }).click();
      await page.getByRole('tablist', { name: 'Show' }).waitFor();
      await page.getByRole('tablist', { name: 'Show' }).getByRole('tab', { name: /^All/ }).click();
      await page.waitForTimeout(1800);
      await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'Board' }).click();
      await page.waitForTimeout(2600);
      await page.getByRole('tablist', { name: 'Display' }).getByRole('tab', { name: 'What Waits on What' }).click();
      await page.waitForTimeout(3200);
    },
  },
  /** Sentinel (docs/sentinel.md): the list, a recipe made and turned on, Run Now, a run's report, and a fix waiting for Merge. */
  sentinel: {
    viewport: { width: 1280, height: 800 },
    async run(page) {
      const main = page.locator('main');
      const list = async () => {
        await side(page).getByRole('button', { name: /^Sentinel/ }).click();
        await main.locator('[data-sentinel]').first().waitFor({ timeout: 30_000 });
      };
      await list();
      await page.waitForTimeout(2200);
      // A recipe: Nightly tests in bob-api, then Turn On.
      await main.getByRole('button', { name: 'New Sentinel' }).first().click();
      const sheet = page.getByRole('dialog', { name: 'New Sentinel' });
      await sheet.getByRole('tab', { name: /Recipe/ }).click();
      await sheet.getByRole('combobox', { name: 'Where it works' }).click();
      await page.getByRole('option', { name: 'bob-api' }).click();
      await page.waitForTimeout(1200);
      for (const id of ['morning-brief', 'fix-and-ship', 'nightly-tests']) {
        await sheet.locator(`[data-recipe="${id}"]`).hover();
        await page.waitForTimeout(600);
      }
      await sheet.locator('[data-recipe="nightly-tests"]').click();
      await main.locator('[data-sentinel-page]').waitFor();
      await page.waitForTimeout(1800);
      await main.getByRole('button', { name: 'Turn On' }).first().click();
      await page.waitForTimeout(1600);
      // Morning brief: Run Now, and the run's report.
      await list();
      await main.getByRole('row', { name: /^Morning brief/ }).click();
      await page.waitForTimeout(1400);
      const history = main.getByRole('region', { name: 'History' });
      const before = await history.locator('[data-run]').count();
      await main.getByRole('button', { name: 'Run Now' }).click();
      await history.locator('[data-run]').nth(before).waitFor({ timeout: 30_000 });
      await history.locator('[data-run]').first().filter({ hasText: 'Done' }).waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1200);
      await history.locator('[data-run]').first().click();
      await main.getByRole('region', { name: 'Report' }).waitFor();
      await page.waitForTimeout(2600);
      // Fix what broke: the fix for #48 waits for your Merge.
      await list();
      await main.getByRole('row', { name: /^Fix what broke/ }).click();
      await main.getByRole('region', { name: 'History' }).locator('[data-run]').filter({ hasText: 'Needs you' }).first().click();
      const decide = main.getByTestId('sentinel-decide');
      await decide.waitFor();
      await page.waitForTimeout(2000);
      await decide.getByRole('button', { name: 'Merge' }).hover();
      await page.waitForTimeout(700);
      await decide.getByRole('button', { name: 'Merge' }).click();
      await main.getByRole('heading', { name: /^Merged #/ }).waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2400);
    },
  },
  /** Max effort sets the message box on fire, in Arcade's pixels: they fly as you type, it flares when you rush, and what you delete bursts. Just the box, cropped. */
  fire: {
    // A narrow window with no sidebar or panel: the box is the whole story.
    viewport: { width: 600, height: 440 },
    // Dark, on GitHub's own dark background, so the GIF fuses with the page.
    background: [0x0d, 0x11, 0x16],
    prefs: { appearance: 'dark', maxFire: { where: 'max', show: 'always', style: 'pixel', fuel: 0.6, height: 0.55, thickness: 0.55, wildness: 0.5, palette: 'red', temper: true, typing: 'pixels', popDelete: true, border: true, preset: 'arcade' } },
    async run(page) {
      await openWorkspace(page, 'add-auth');
      for (const what of ['Hide the panel', 'Hide the sidebar']) {
        await page.keyboard.press('Meta+K');
        await page.keyboard.type(what, { delay: 10 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
      }
      await page.getByRole('button', { name: 'Agent, model and effort' }).click();
      await page.getByRole('radio', { name: 'Max', exact: true }).click();
      await page.keyboard.press('Escape');
      // Nothing around the box but its fire, on GitHub's background: the rest of the chat goes.
      await page.locator('main [data-fire]').first().evaluate((box) => {
        for (let el = box; el && el.tagName !== 'MAIN'; el = el.parentElement) {
          for (const other of el.parentElement?.children ?? []) if (other !== el && other.tagName !== 'CANVAS') other.style.visibility = 'hidden';
        }
        for (let el = box.parentElement; el; el = el.parentElement) el.style.setProperty('background', '#0d1116', 'important');
      });
      await composer(page).click();
      // The box sizes itself on input: one key in and out fits it to the window it has now.
      await page.keyboard.press('a');
      await page.keyboard.press('Backspace');
      // The GIF starts here, with the box already alight.
      await page.waitForTimeout(1800);
      const from = await page.evaluate(() => performance.now() / 1000);
      await page.waitForTimeout(1400);
      await page.keyboard.type('Make checkout ', { delay: 90 });
      // Rushing: it loses its temper and flares.
      await page.keyboard.type('never drop a payment, ever, not even once', { delay: 16 });
      await page.waitForTimeout(1300);
      // What you take back pops into pixels.
      for (let i = 0; i < ', ever, not even once'.length; i++) await page.keyboard.press('Backspace', { delay: 45 });
      await page.waitForTimeout(700);
      await page.keyboard.type(', even on a slow day', { delay: 75 });
      await page.waitForTimeout(1600);
      // All of it at once: one big burst, and the box is empty again for the loop.
      await page.keyboard.press('Meta+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(2400);
      const box = await page.locator('main [data-fire]').first().boundingBox();
      const top = Math.max(0, Math.round(box.y - 150));
      const left = Math.max(0, Math.round(box.x - 24));
      return { from, crop: { x: left, y: top, w: Math.min(600 - left, Math.round(box.width + 48)), h: Math.min(440 - top, Math.round(box.y + box.height + 14 - top)) } };
    },
  },
  /** The Scratch tab: what Claude and its sub-agents save while they work (screenshots, test logs, JSON), live. */
  scratch: {
    viewport: { width: 1280, height: 800 },
    async run(page) {
      await openWorkspace(page, 'add-auth');
      await page.keyboard.press('Meta+Alt+6');
      const finder = page.getByRole('complementary', { name: 'Panel' }).getByRole('button', { name: 'Show in Finder' });
      await finder.waitFor();
      const dir = await finder.getAttribute('title');
      for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { recursive: true, force: true });
      await page.waitForTimeout(800);
      await say(page, 'review my changes, and screenshot the login page while you test it');
      // What the reviewers save as they go: a test log that grows, the page they checked, the response they got.
      const write = (name, data) => writeFileSync(path.join(dir, name), data);
      await page.waitForTimeout(1600);
      write('01-npm-test.log', '> bob-api@1.0.0 test\n> vitest run\n\n');
      for (const t of ['auth.test.ts (6)', 'server.test.ts (9)', 'payments.test.ts (8)', 'webhooks.test.ts (4)']) {
        await page.waitForTimeout(700);
        appendFileSync(path.join(dir, '01-npm-test.log'), ` ✓ tests/${t}\n`);
      }
      appendFileSync(path.join(dir, '01-npm-test.log'), '\n Test Files  4 passed (4)\n      Tests  27 passed (27)\n');
      await page.waitForTimeout(1400);
      write('02-login-page.png', LOGIN_SHOT);
      await page.waitForTimeout(2600);
      write('03-session-response.json', JSON.stringify({ status: 401, error: 'no session', headers: { 'set-cookie': 'sid=…; HttpOnly; SameSite=Lax' } }));
      await page.waitForTimeout(2400);
      await page.getByRole('listbox', { name: 'Scratch files' }).getByRole('option', { name: /02-login-page\.png/ }).click();
      await page.waitForTimeout(3000);
    },
  },
};

/** A login page for the scratch scene's "screenshot": drawn here so the GIF needs nothing from outside. */
let LOGIN_SHOT;
async function drawLogin(browser) {
  const page = await browser.newPage({ viewport: { width: 640, height: 420 } });
  await page.setContent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:#f4f1fb;font:15px -apple-system,sans-serif">
    <form style="width:300px;padding:28px;border-radius:14px;background:#fff;box-shadow:0 8px 30px rgba(80,60,140,.12)">
      <div style="font-size:20px;font-weight:600;margin-bottom:18px;color:#2b2540">Sign in to bob-api</div>
      <div style="color:#6b6680;font-size:12px;margin-bottom:4px">Email</div><div style="border:1px solid #ddd8ec;border-radius:8px;padding:9px;margin-bottom:12px">kay@example.com</div>
      <div style="color:#6b6680;font-size:12px;margin-bottom:4px">Password</div><div style="border:1px solid #ddd8ec;border-radius:8px;padding:9px;margin-bottom:18px">••••••••</div>
      <div style="background:#9b8ce0;color:#fff;text-align:center;border-radius:8px;padding:10px;font-weight:600">Sign in</div>
    </form></body>`);
  LOGIN_SHOT = await page.screenshot();
  await page.close();
}

async function openWorkspace(page, name) {
  const row = side(page).getByRole('button', { name, exact: true });
  if (!(await row.isVisible().catch(() => false))) await side(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await side(page).getByRole('button', { name, exact: true }).click();
  await untilIdle(page);
  await page.waitForTimeout(800);
}

async function untilIdle(page) {
  await page.getByRole('button', { name: 'Stop Claude' }).waitFor({ state: 'detached', timeout: 90_000 }).catch(() => {});
}

async function record(name, scene, browser) {
  rmSync(path.join(tmp, name), { recursive: true, force: true });
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: scene.viewport, colorScheme: 'light', recordVideo: { dir, size: scene.viewport } });
  // Past the first-run welcome.
  await context.addInitScript((prefs) => {
    localStorage.setItem('beluga.onboarding.v1', JSON.stringify({ version: 'gifs', at: 0, how: 'finished' }));
    if (prefs) localStorage.setItem('beluga.prefs.v1', JSON.stringify(prefs));
  }, scene.prefs);
  const page = await context.newPage();
  await page.goto(`${url}${scene.path ?? '/'}`);
  if (!scene.path) await side(page).waitFor();
  await page.waitForTimeout(600);
  // A scene can say where its GIF starts (seconds into the page) and crop to one part of the window.
  const { from, crop } = (await scene.run(page, context)) ?? {};
  const video = await page.video()?.path();
  await context.close();
  const webm = path.join(dir, 'scene.webm');
  renameSync(video ?? path.join(dir, readdirSync(dir).find((f) => f.endsWith('.webm'))), webm);
  const gif = path.join(out, `${name}.gif`);
  const width = Math.min(crop?.w ?? scene.viewport.width, 1100);
  const cut = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : '';
  // A background colour the GIF must hit exactly (to fuse with GitHub's page): what the video blurred near it goes back to it, undithered.
  const bg = scene.background;
  const near = bg && `lt(abs(r(X,Y)-${bg[0]})+abs(g(X,Y)-${bg[1]})+abs(b(X,Y)-${bg[2]}),14)`;
  const snap = bg ? `format=rgb24,geq=r='if(${near},${bg[0]},r(X,Y))':g='if(${near},${bg[1]},g(X,Y))':b='if(${near},${bg[2]},b(X,Y))',` : '';
  const use = bg ? 'paletteuse=dither=none' : 'paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  // Trim the blank first frames, then a palette made for this scene.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(from ?? scene.trim ?? 0.8), '-i', webm, '-vf', `${cut}fps=${scene.fps ?? 12},scale=${width}:-1:flags=lanczos,${snap}split[a][b];[a]palettegen=max_colors=${scene.colors ?? 160}:stats_mode=${bg ? 'full' : 'diff'}[p];[b][p]${use}`, '-loop', '0', gif]);
  console.log(`${name}: ${gif}`);
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  await drawLogin(browser);
  for (const [name, scene] of Object.entries(SCENES)) if (!only.length || only.includes(name)) await record(name, scene, browser);
} finally {
  await browser.close();
}
