/**
 * The window's themes (BLG-696): Beluga's Light and Dark (styles/tokens.css), Beluga's own others
 * (Super Dark, OLED, Abyss, Arctic) and the well-known ones. A theme sits on its base's tokens
 * (data-theme stays 'light' or 'dark', so every light/dark rule in the screens still holds) and
 * repaints the surfaces, text and the colours that mean something (data-palette).
 * One table drives the CSS, Settings' previews and the readability test.
 */

export type ThemeBase = 'light' | 'dark';

/** The colours a theme gives (each one a design token of the same name). */
export interface ThemeColors {
  readonly bg: string;
  readonly sunken: string;
  readonly sidebar: string;
  readonly raised: string;
  readonly code: string;
  readonly term: string;
  readonly text: string;
  readonly text2: string;
  readonly text3: string;
  readonly claude: string;
  readonly ok: string;
  readonly warn: string;
  readonly error: string;
  readonly info: string;
  readonly merged: string;
  readonly subagent: string;
  readonly worktree: string;
  readonly plan: string;
  readonly epic: string;
  readonly hairline?: string;
  readonly hairlineStrong?: string;
  readonly hover?: string;
  readonly press?: string;
  /** Popovers and sheets: on near-black a drop shadow can't be seen, so a lit rim does its work. */
  readonly shadowPop?: string;
}

export interface AppTheme {
  readonly id: string;
  readonly name: string;
  readonly base: ThemeBase;
  /** Beluga's own, or a well-known theme brought over. */
  readonly by: 'beluga' | 'classic';
  readonly colors: ThemeColors;
  /** Its own accent, used while Accent is Theme (or System, picked with it). */
  readonly accent?: string;
  /** Wide-colour versions (Display P3) for screens that show them: a Mac's Retina and XDR screens. */
  readonly p3?: Partial<Pick<ThemeColors, 'claude' | 'ok' | 'warn' | 'error' | 'info' | 'merged' | 'subagent' | 'worktree' | 'plan' | 'epic'>> & { readonly accent?: string };
  /** The terminal theme (lib/terminal-themes.ts) whose colours go with it, while the terminal uses Beluga's own. */
  readonly term?: string;
  /**
   * Near-black, where shadows vanish and surfaces fuse: the cards, the message box, sheets and
   * buttons get a lit edge instead (a fine light rim, a faint highlight along the top; no glow).
   */
  readonly lit?: boolean;
  /** Beluga's Light and Dark: their tokens are tokens.css itself (the colours here are for the previews). */
  readonly builtin?: boolean;
}

const c = (colors: ThemeColors): ThemeColors => colors;

export const THEMES: readonly AppTheme[] = [
  // ---- Dark
  {
    id: 'dark',
    name: 'Dark',
    base: 'dark',
    by: 'beluga',
    builtin: true,
    colors: c({ bg: '#1e1e21', sunken: '#19191b', sidebar: '#26262a', raised: '#2a2a2e', code: '#242427', term: '#17171a', text: '#ececee', text2: '#a8a8ae', text3: '#75757c', claude: '#df946a', ok: '#6cc187', warn: '#e3a64a', error: '#ef7a72', info: '#79aef0', merged: '#b294f0', subagent: '#ab93f3', worktree: '#66c6bb', plan: '#e892c3', epic: '#a4aaf6' }),
  },
  {
    id: 'super-dark',
    name: 'Super Dark',
    base: 'dark',
    by: 'beluga',
    lit: true,
    colors: c({ bg: '#111113', sunken: '#0c0c0e', sidebar: '#161618', raised: '#1c1c1f', code: '#18181b', term: '#0b0b0d', text: '#efeff1', text2: '#a4a4ab', text3: '#6d6d75', claude: '#e39a70', ok: '#6fc78b', warn: '#e8ab4f', error: '#f27d75', info: '#7fb3f3', merged: '#b79af2', subagent: '#ae97f5', worktree: '#6bcabf', plan: '#ec97c7', epic: '#a9aff8' }),
  },
  {
    id: 'oled',
    name: 'OLED Black',
    base: 'dark',
    by: 'beluga',
    accent: '#3fb4ff',
    lit: true,
    // The canvas stays true black (the pixels off); what sits on it is lifted a hair, and edged in light.
    colors: c({ bg: '#000000', sunken: '#08080a', sidebar: '#000000', raised: '#111114', code: '#0c0c0f', term: '#000000', text: '#f5f5f7', text2: '#a1a1a8', text3: '#6b6b72', claude: '#f0a070', ok: '#5fd88a', warn: '#f5b640', error: '#ff6b62', info: '#5eb0ff', merged: '#b98cff', subagent: '#ad8cff', worktree: '#45d6c6', plan: '#ff8acb', epic: '#9aa2ff', hairline: 'rgba(255, 255, 255, 0.12)', hairlineStrong: 'rgba(255, 255, 255, 0.2)', hover: 'rgba(255, 255, 255, 0.07)', press: 'rgba(255, 255, 255, 0.12)', shadowPop: '0 0 0 0.5px rgba(255, 255, 255, 0.22), inset 0 0.5px 0 rgba(255, 255, 255, 0.1), 0 16px 48px rgba(0, 0, 0, 0.9)' }),
    // The colours a Mac's screen can show that sRGB can't: brighter, deeper, on true black.
    p3: {
      accent: 'color(display-p3 0.2 0.7 1)',
      claude: 'color(display-p3 1 0.6 0.38)',
      ok: 'color(display-p3 0.3 0.9 0.5)',
      warn: 'color(display-p3 1 0.72 0.2)',
      error: 'color(display-p3 1 0.38 0.34)',
      info: 'color(display-p3 0.32 0.68 1)',
      merged: 'color(display-p3 0.72 0.54 1)',
      subagent: 'color(display-p3 0.68 0.54 1)',
      worktree: 'color(display-p3 0.2 0.86 0.78)',
      plan: 'color(display-p3 1 0.52 0.8)',
      epic: 'color(display-p3 0.6 0.63 1)',
    },
  },
  {
    id: 'abyss',
    name: 'Abyss',
    base: 'dark',
    by: 'beluga',
    accent: '#5cc6d6',
    colors: c({ bg: '#0b1620', sunken: '#08111a', sidebar: '#0e1a25', raised: '#13222f', code: '#0f1d29', term: '#07101a', text: '#dfe9f0', text2: '#94aab9', text3: '#617a8b', claude: '#eba47e', ok: '#6fd0a0', warn: '#e9bc6a', error: '#f2867c', info: '#76b8ee', merged: '#a99cf0', subagent: '#a79df5', worktree: '#5cc6d6', plan: '#e79ac4', epic: '#9fb0f7' }),
  },
  {
    id: 'dracula',
    name: 'Dracula',
    base: 'dark',
    by: 'classic',
    accent: '#bd93f9',
    term: 'Dracula',
    colors: c({ bg: '#282a36', sunken: '#21222c', sidebar: '#21222c', raised: '#343746', code: '#21222c', term: '#282a36', text: '#f8f8f2', text2: '#c3c6d9', text3: '#7c88b8', claude: '#ffb86c', ok: '#50fa7b', warn: '#f1fa8c', error: '#ff5555', info: '#8be9fd', merged: '#bd93f9', subagent: '#bd93f9', worktree: '#8be9fd', plan: '#ff79c6', epic: '#a4aaf6' }),
  },
  {
    id: 'mocha',
    name: 'Catppuccin Mocha',
    base: 'dark',
    by: 'classic',
    accent: '#cba6f7',
    term: 'Catppuccin',
    colors: c({ bg: '#1e1e2e', sunken: '#181825', sidebar: '#181825', raised: '#313244', code: '#181825', term: '#1e1e2e', text: '#cdd6f4', text2: '#a6adc8', text3: '#7f849c', claude: '#fab387', ok: '#a6e3a1', warn: '#f9e2af', error: '#f38ba8', info: '#89b4fa', merged: '#cba6f7', subagent: '#b4befe', worktree: '#94e2d5', plan: '#f5c2e7', epic: '#b4befe' }),
  },
  {
    id: 'macchiato',
    name: 'Catppuccin Macchiato',
    base: 'dark',
    by: 'classic',
    accent: '#c6a0f6',
    term: 'Catppuccin',
    colors: c({ bg: '#24273a', sunken: '#1e2030', sidebar: '#1e2030', raised: '#363a4f', code: '#1e2030', term: '#24273a', text: '#cad3f5', text2: '#a5adcb', text3: '#8087a2', claude: '#f5a97f', ok: '#a6da95', warn: '#eed49f', error: '#ed8796', info: '#8aadf4', merged: '#c6a0f6', subagent: '#b7bdf8', worktree: '#8bd5ca', plan: '#f5bde6', epic: '#b7bdf8' }),
  },
  {
    id: 'frappe',
    name: 'Catppuccin Frappé',
    base: 'dark',
    by: 'classic',
    accent: '#ca9ee6',
    term: 'Catppuccin',
    colors: c({ bg: '#303446', sunken: '#292c3c', sidebar: '#292c3c', raised: '#414559', code: '#292c3c', term: '#303446', text: '#c6d0f5', text2: '#b5bfe2', text3: '#838ba7', claude: '#ef9f76', ok: '#a6d189', warn: '#e5c890', error: '#e78284', info: '#8caaee', merged: '#ca9ee6', subagent: '#babbf1', worktree: '#81c8be', plan: '#f4b8e4', epic: '#babbf1' }),
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    base: 'dark',
    by: 'classic',
    accent: '#7aa2f7',
    term: 'Tokyo Night',
    colors: c({ bg: '#1a1b26', sunken: '#16161e', sidebar: '#16161e', raised: '#24283b', code: '#16161e', term: '#1a1b26', text: '#c0caf5', text2: '#a9b1d6', text3: '#646e9c', claude: '#ff9e64', ok: '#9ece6a', warn: '#e0af68', error: '#f7768e', info: '#7dcfff', merged: '#bb9af7', subagent: '#bb9af7', worktree: '#73daca', plan: '#f4a3d0', epic: '#a9b8fa' }),
  },
  {
    id: 'nord',
    name: 'Nord',
    base: 'dark',
    by: 'classic',
    accent: '#88c0d0',
    term: 'Nord',
    colors: c({ bg: '#2e3440', sunken: '#292e39', sidebar: '#2a2f3a', raised: '#3b4252', code: '#292e39', term: '#2e3440', text: '#eceff4', text2: '#c0c8d6', text3: '#8590a6', claude: '#d08770', ok: '#a3be8c', warn: '#ebcb8b', error: '#bf616a', info: '#81a1c1', merged: '#b48ead', subagent: '#b48ead', worktree: '#8fbcbb', plan: '#d4a0c4', epic: '#9cb3d6' }),
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    base: 'dark',
    by: 'classic',
    accent: '#83a598',
    term: 'Gruvbox',
    colors: c({ bg: '#282828', sunken: '#1d2021', sidebar: '#1d2021', raised: '#3c3836', code: '#1d2021', term: '#282828', text: '#ebdbb2', text2: '#bdae93', text3: '#928374', claude: '#fe8019', ok: '#b8bb26', warn: '#fabd2f', error: '#fb4934', info: '#83a598', merged: '#d3869b', subagent: '#d3869b', worktree: '#8ec07c', plan: '#e39ab0', epic: '#a3b5c9' }),
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    base: 'dark',
    by: 'classic',
    accent: '#c4a7e7',
    term: 'Rosé Pine',
    colors: c({ bg: '#191724', sunken: '#16141f', sidebar: '#1f1d2e', raised: '#26233a', code: '#1f1d2e', term: '#191724', text: '#e0def4', text2: '#a8a4c2', text3: '#6e6a86', claude: '#ebbcba', ok: '#9ccfd8', warn: '#f6c177', error: '#eb6f92', info: '#7fb8d4', merged: '#c4a7e7', subagent: '#c4a7e7', worktree: '#9ccfd8', plan: '#ebbcba', epic: '#b1b5ec' }),
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    base: 'dark',
    by: 'classic',
    accent: '#61afef',
    colors: c({ bg: '#282c34', sunken: '#21252b', sidebar: '#21252b', raised: '#2f343e', code: '#21252b', term: '#282c34', text: '#dcdfe4', text2: '#abb2bf', text3: '#737b8c', claude: '#d19a66', ok: '#98c379', warn: '#e5c07b', error: '#e06c75', info: '#61afef', merged: '#c678dd', subagent: '#c678dd', worktree: '#56b6c2', plan: '#e38fc3', epic: '#9aa7f2' }),
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    base: 'dark',
    by: 'classic',
    accent: '#4493f8',
    colors: c({ bg: '#0d1117', sunken: '#010409', sidebar: '#010409', raised: '#161b22', code: '#161b22', term: '#0d1117', text: '#e6edf3', text2: '#9198a1', text3: '#6e7681', claude: '#f0883e', ok: '#3fb950', warn: '#d29922', error: '#f85149', info: '#58a6ff', merged: '#a371f7', subagent: '#a371f7', worktree: '#39c5cf', plan: '#db61a2', epic: '#8b9cf7' }),
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    base: 'dark',
    by: 'classic',
    accent: '#268bd2',
    term: 'Solarized',
    colors: c({ bg: '#002b36', sunken: '#00252f', sidebar: '#00252f', raised: '#073642', code: '#00252f', term: '#002b36', text: '#eee8d5', text2: '#93a1a1', text3: '#6c8288', claude: '#cb4b16', ok: '#859900', warn: '#b58900', error: '#dc322f', info: '#268bd2', merged: '#6c71c4', subagent: '#6c71c4', worktree: '#2aa198', plan: '#d33682', epic: '#7f85d6' }),
  },
  // ---- Light
  {
    id: 'light',
    name: 'Light',
    base: 'light',
    by: 'beluga',
    builtin: true,
    colors: c({ bg: '#ffffff', sunken: '#f8f9fb', sidebar: '#f4f5f9', raised: '#ffffff', code: '#f4f4f6', term: '#fbfbfc', text: '#1d1d1f', text2: '#5d5d63', text3: '#8e8e93', claude: '#b4693f', ok: '#2f8a4c', warn: '#b36b00', error: '#c4352e', info: '#2f6cb3', merged: '#8a63d2', subagent: '#7656c9', worktree: '#24877f', plan: '#b84d8a', epic: '#5a62cf' }),
  },
  {
    id: 'arctic',
    name: 'Arctic',
    base: 'light',
    by: 'beluga',
    accent: '#2683b0',
    colors: c({ bg: '#f8fbfd', sunken: '#eff5f9', sidebar: '#e8f0f6', raised: '#ffffff', code: '#edf3f7', term: '#f3f8fb', text: '#13222e', text2: '#4c6272', text3: '#7d93a3', claude: '#b4693f', ok: '#23845a', warn: '#ad6a00', error: '#c23a33', info: '#2671b5', merged: '#7b62cc', subagent: '#6d5ac8', worktree: '#1a8380', plan: '#b14f8a', epic: '#4f66c9' }),
  },
  {
    id: 'latte',
    name: 'Catppuccin Latte',
    base: 'light',
    by: 'classic',
    accent: '#8839ef',
    term: 'Catppuccin',
    colors: c({ bg: '#eff1f5', sunken: '#e6e9ef', sidebar: '#e6e9ef', raised: '#f7f8fa', code: '#e6e9ef', term: '#eff1f5', text: '#4c4f69', text2: '#5c5f77', text3: '#8c8fa1', claude: '#fe640b', ok: '#40a02b', warn: '#c27c10', error: '#d20f39', info: '#1e66f5', merged: '#8839ef', subagent: '#7287fd', worktree: '#179299', plan: '#ea76cb', epic: '#7287fd' }),
  },
  {
    id: 'rose-pine-dawn',
    name: 'Rosé Pine Dawn',
    base: 'light',
    by: 'classic',
    accent: '#907aa9',
    term: 'Rosé Pine',
    colors: c({ bg: '#faf4ed', sunken: '#f2e9e1', sidebar: '#f2e9e1', raised: '#fffaf3', code: '#f2e9e1', term: '#faf4ed', text: '#575279', text2: '#605b7e', text3: '#9893a5', claude: '#d7827e', ok: '#286983', warn: '#c47f22', error: '#b4637a', info: '#56949f', merged: '#907aa9', subagent: '#907aa9', worktree: '#56949f', plan: '#d7827e', epic: '#7d86c0' }),
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    base: 'light',
    by: 'classic',
    accent: '#0969da',
    colors: c({ bg: '#ffffff', sunken: '#f6f8fa', sidebar: '#f6f8fa', raised: '#ffffff', code: '#f6f8fa', term: '#ffffff', text: '#1f2328', text2: '#59636e', text3: '#818b98', claude: '#bc4c00', ok: '#1a7f37', warn: '#9a6700', error: '#d1242f', info: '#0969da', merged: '#8250df', subagent: '#8250df', worktree: '#1b7c83', plan: '#bf3989', epic: '#5a62cf' }),
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    base: 'light',
    by: 'classic',
    accent: '#268bd2',
    term: 'Solarized',
    colors: c({ bg: '#fdf6e3', sunken: '#f5eedb', sidebar: '#eee8d5', raised: '#fffbf0', code: '#eee8d5', term: '#fdf6e3', text: '#073642', text2: '#51666d', text3: '#849596', claude: '#cb4b16', ok: '#859900', warn: '#b58900', error: '#dc322f', info: '#268bd2', merged: '#6c71c4', subagent: '#6c71c4', worktree: '#2aa198', plan: '#d33682', epic: '#6c71c4' }),
  },
];

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** A saved theme for that base, or Beluga's own Light or Dark when it's unknown or the other base's. */
export function themeIdOf(value: unknown, base: ThemeBase): string {
  const t = typeof value === 'string' ? BY_ID.get(value) : undefined;
  return t && t.base === base ? t.id : base;
}

export const themeById = (id: string): AppTheme | undefined => BY_ID.get(id);

/** The theme showing for a base, from the two you picked (one for light, one for dark). */
export const themeFor = (base: ThemeBase, picked: { readonly lightTheme: string; readonly darkTheme: string }): AppTheme => BY_ID.get(themeIdOf(base === 'dark' ? picked.darkTheme : picked.lightTheme, base))!;

/** What picking a theme changes: its slot, the appearance when it's the other base's (you see it at once), and the accent to the theme's own when you had the system's. */
export function themePatch(id: string, now: { readonly appearance: 'system' | ThemeBase; readonly accent: string }, showing: ThemeBase): { lightTheme?: string; darkTheme?: string; appearance?: ThemeBase; accent?: 'theme' } {
  const t = BY_ID.get(id);
  if (!t) return {};
  return {
    ...(t.base === 'dark' ? { darkTheme: t.id } : { lightTheme: t.id }),
    ...(t.base !== showing ? { appearance: t.base } : {}),
    ...(t.accent && now.accent === 'system' ? { accent: 'theme' as const } : {}),
  };
}

const TOKENS: ReadonlyArray<readonly [keyof ThemeColors, string]> = [
  ['bg', '--bg'],
  ['sunken', '--bg-sunken'],
  ['sidebar', '--bg-sidebar-solid'],
  ['raised', '--bg-raised'],
  ['code', '--code-bg'],
  ['term', '--term-bg'],
  ['text', '--text'],
  ['text2', '--text-2'],
  ['text3', '--text-3'],
  ['claude', '--claude'],
  ['ok', '--ok'],
  ['warn', '--warn'],
  ['error', '--error'],
  ['info', '--info'],
  ['merged', '--merged'],
  ['subagent', '--subagent'],
  ['worktree', '--worktree'],
  ['plan', '--plan'],
  ['epic', '--epic'],
  ['hairline', '--hairline'],
  ['hairlineStrong', '--hairline-strong'],
  ['hover', '--bg-hover'],
  ['press', '--bg-press'],
  ['shadowPop', '--shadow-pop'],
];

/** One theme's CSS: on its base's tokens, an opaque sidebar (no blur under a theme's own colours), its accent, and P3 where the screen has it. */
export function themeCss(t: AppTheme): string {
  // [data-theme] too, to win over tokens.css's :root[data-theme='dark'] whatever order the sheets load in.
  const sel = `:root[data-theme='${t.base}'][data-palette='${t.id}']`;
  const lines = TOKENS.flatMap(([k, v]) => (t.colors[k] ? [`  ${v}: ${t.colors[k]};`] : []));
  lines.push(`  --bg-sidebar: ${t.colors.sidebar};`);
  if (t.accent) lines.push(`  --theme-accent: ${t.accent};`);
  // The highlight along a lit surface's top edge (data-edges='lit': the screens' own CSS puts it on).
  if (t.lit) lines.push('  --rim: inset 0 0.5px 0 rgba(255, 255, 255, 0.09);');
  const wide = t.p3 ? Object.entries(t.p3).map(([k, v]) => `    ${k === 'accent' ? '--theme-accent' : TOKENS.find(([key]) => key === k)![1]}: ${v};`) : [];
  return `${sel} {\n${lines.join('\n')}\n}\n${wide.length ? `@media (color-gamut: p3) {\n  ${sel} {\n${wide.join('\n')}\n  }\n}\n` : ''}`;
}

/** Every theme's CSS but Light and Dark's (tokens.css has those). */
export const allThemesCss = (): string => THEMES.filter((t) => !t.builtin).map(themeCss).join('\n');

/** A theme draws over the window's blur with its own sidebar (Beluga's Dark and Light let it through). */
export const isSolid = (t: AppTheme): boolean => !t.builtin;

// ---- Readability (the test holds every theme to it)

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
/** WCAG contrast between two #rrggbb colours (1–21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
