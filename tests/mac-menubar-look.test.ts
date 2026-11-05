import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MENU_BAR, MENU_BAR_PRESETS, menuBarLookOf, menuBarPresetOf, spoutStep, trayTitle } from '../packages/mac/src/menubar/menubar-look.js';
import { ICON_H, ICON_W, TRAY_INK_OFF_MAC, frameCount, spoutFrames, spoutSvg } from '../packages/mac/src/menubar/spout.js';

const counts = { new: 3, waiting: 1, working: 2, room: 4, friends: 0 };

describe('the menu-bar number (BLG-280)', () => {
  it('counts what you picked, in words if you like, and hides at zero', () => {
    expect(trayTitle({ count: 'new', words: false }, counts)).toBe('3');
    expect(trayTitle({ count: 'room', words: true }, counts)).toBe('4 here');
    expect(trayTitle({ count: 'working', words: true }, counts)).toBe('2 working');
    expect(trayTitle({ count: 'friends', words: true }, counts)).toBe('');
    expect(trayTitle({ count: 'none', words: true }, counts)).toBe('');
  });

  it('keeps saved settings whole and names their preset', () => {
    expect(menuBarLookOf(undefined)).toEqual(DEFAULT_MENU_BAR);
    expect(menuBarLookOf({ count: 'bogus', splash: 'big', speed: Number.NaN })).toEqual(DEFAULT_MENU_BAR);
    for (const p of MENU_BAR_PRESETS) expect(menuBarPresetOf(p.look)).toBe(p.id);
    expect(menuBarLookOf({ ...DEFAULT_MENU_BAR, splash: 0.9 }).preset).toBe('custom');
  });

  it('spouts once as a Claude finishes, on and off while one works', () => {
    expect(spoutStep('done', undefined, 0)).toBeUndefined();
    expect(spoutStep('done', 2, 1)).toBe('once');
    expect(spoutStep('done', 1, 2)).toBeUndefined();
    expect(spoutStep('working', 0, 1)).toBe('repeat');
    expect(spoutStep('working', 1, 0)).toBe('stop');
    expect(spoutStep('off', 2, 0)).toBeUndefined();
  });
});

describe('the spout', () => {
  /** The frame's pixels' alpha, at the menu bar's size. */
  const alpha = (svg: string): { at: (x: number, y: number) => number } => {
    const img = new Resvg(svg).render();
    const px = img.pixels;
    return { at: (x, y) => px[(y * img.width + x) * 4 + 3]! };
  };

  it('starts and ends at rest, so it never jumps', () => {
    for (const look of [{ splash: 0, speed: 1 }, { splash: 1, speed: 0 }]) {
      const frames = spoutFrames(look);
      expect(frames).toHaveLength(frameCount(look));
      expect(frames[0]).toBe(spoutSvg(0, look));
      expect(frames.at(-1)).toBe(spoutSvg(0, look));
    }
  });

  it('keeps the tipped whale and its water inside the icon, never cut off at an edge', () => {
    for (const splash of [0, 0.5, 1]) {
      const look = { splash, speed: 0.5 };
      const count = frameCount(look);
      for (let i = 1; i < count - 1; i++) {
        const t = i / (count - 1);
        // While it's tipped (at rest it's the usual icon, which touches its edges).
        if (t < 0.25 || t > 0.65) continue;
        const a = alpha(spoutSvg(t, look));
        for (let y = 0; y < ICON_H; y++) for (const x of [0, ICON_W - 1]) expect(a.at(x, y), `splash ${splash}, t ${t.toFixed(2)}, x ${x} y ${y}`).toBe(0);
        for (let x = 0; x < ICON_W; x++) expect(a.at(x, 0), `splash ${splash}, t ${t.toFixed(2)}, top x ${x}`).toBe(0);
      }
    }
    // Draws dozens of frames: about 6s on a Mac, past the usual 30s on a Windows runner.
  }, 120_000);
});

describe('the tray whale off the Mac', () => {
  it('is drawn in blue, readable on light and dark bars (the Mac tints its black template)', () => {
    const [first] = spoutFrames(DEFAULT_MENU_BAR, undefined, TRAY_INK_OFF_MAC);
    expect(first).toContain(`fill="${TRAY_INK_OFF_MAC}"`);
    expect(spoutFrames(DEFAULT_MENU_BAR)[0]).toContain('fill="#000"');
  });
});
