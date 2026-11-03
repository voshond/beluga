import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES, allThemesCss, contrast, isSolid, themeCss, themeFor, themeIdOf, themePatch } from '../packages/mac/src/lib/themes.js';
import { TERMINAL_PRESETS } from '../packages/mac/src/lib/terminal-themes.js';

const picked = { lightTheme: 'light', darkTheme: 'dark' };

describe('the window themes (BLG-696)', () => {
  it('has unique ids, Light and Dark first-class, and a terminal theme that exists for each one that names it', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['light', 'dark', 'super-dark', 'oled', 'dracula', 'mocha', 'latte']));
    for (const t of THEMES) if (t.term) expect(TERMINAL_PRESETS.map((p) => p.name)).toContain(t.term);
  });

  it.each(THEMES.map((t) => [t.name, t] as const))('%s is readable', (_, t) => {
    const k = t.colors;
    for (const surface of [k.bg, k.raised, k.sidebar]) {
      // 6: the well-known themes' own text sits at 6–7 (Latte, Frappé, Dawn), well over WCAG's 4.5.
      expect(contrast(k.text, surface), `text on ${surface}`).toBeGreaterThanOrEqual(6);
      expect(contrast(k.text2, surface), `secondary text on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(k.text3, surface), `faint text on ${surface}`).toBeGreaterThanOrEqual(2.4);
    }
    for (const state of [k.ok, k.warn, k.error, k.info, k.claude]) expect(contrast(state, k.bg), `${state} on ${k.bg}`).toBeGreaterThanOrEqual(2.4);
  });

  it('keeps Light and Dark’s previews true to tokens.css', () => {
    const css = readFileSync('packages/mac/src/styles/tokens.css', 'utf8');
    for (const base of ['light', 'dark'] as const) {
      const block = css.slice(css.indexOf(`:root[data-theme='${base}']`));
      const t = THEMES.find((th) => th.id === base)!;
      expect(block).toContain(`--bg: ${t.colors.bg};`);
      expect(block).toContain(`--text: ${t.colors.text};`);
      expect(block).toContain(`--bg-sidebar-solid: ${t.colors.sidebar};`);
    }
  });

  it('writes a theme over its base, opaque, with its accent and P3 colours where the screen has them', () => {
    const oled = themeCss(THEMES.find((t) => t.id === 'oled')!);
    expect(oled).toContain(":root[data-theme='dark'][data-palette='oled'] {");
    expect(oled).toContain('--bg: #000000;');
    expect(oled).toContain('--bg-sidebar: #000000;');
    // On black a shadow can't show: what sits on it is lifted a hair and edged in light.
    expect(oled).toContain('--bg-raised: #111114;');
    expect(oled).toMatch(/--shadow-pop: 0 0 0 0\.5px rgba\(255, 255, 255, [0-9.]+\), inset/);
    expect(oled).toContain('--rim: inset 0 0.5px 0');
    expect(themeCss(THEMES.find((t) => t.id === 'dracula')!)).not.toContain('--rim');
    expect(oled).toContain('--theme-accent: #3fb4ff;');
    expect(oled).toMatch(/@media \(color-gamut: p3\) \{[\s\S]*--theme-accent: color\(display-p3/);
    expect(allThemesCss()).not.toContain("[data-palette='dark']");
    expect(isSolid(THEMES.find((t) => t.id === 'dark')!)).toBe(false);
    expect(isSolid(THEMES.find((t) => t.id === 'oled')!)).toBe(true);
  });

  it('falls back to Light or Dark for an unknown theme or one of the other base', () => {
    expect(themeIdOf('dracula', 'dark')).toBe('dracula');
    expect(themeIdOf('dracula', 'light')).toBe('light');
    expect(themeIdOf('gone', 'dark')).toBe('dark');
    expect(themeIdOf(undefined, 'light')).toBe('light');
    expect(themeFor('dark', { ...picked, darkTheme: 'oled' }).id).toBe('oled');
    expect(themeFor('light', { ...picked, darkTheme: 'oled' }).id).toBe('light');
  });

  it('shows a picked theme at once, with its own accent when you had the system’s', () => {
    expect(themePatch('dracula', { appearance: 'light', accent: 'system' }, 'light')).toEqual({ darkTheme: 'dracula', appearance: 'dark', accent: 'theme' });
    expect(themePatch('dracula', { appearance: 'system', accent: 'rose' }, 'dark')).toEqual({ darkTheme: 'dracula' });
    expect(themePatch('super-dark', { appearance: 'dark', accent: 'system' }, 'dark')).toEqual({ darkTheme: 'super-dark' });
    expect(themePatch('latte', { appearance: 'dark', accent: 'theme' }, 'dark')).toEqual({ lightTheme: 'latte', appearance: 'light' });
    expect(themePatch('nope', { appearance: 'dark', accent: 'system' }, 'dark')).toEqual({});
  });
});
