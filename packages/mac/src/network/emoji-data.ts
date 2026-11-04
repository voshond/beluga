import type { IconName } from '../components/Icon.js';

/**
 * The full emoji picker's data (BLG-702): Emojibase's English set (emojibase-data), loaded only
 * when the picker first opens, in its categories and in Unicode's order, and searched by name
 * and tags. Skin-tone variants and the bare building blocks (regional letters, tones) are left
 * out: the picker shows each emoji once. So are emojis newer than MAX_VERSION: the Macs and phones
 * of today draw them as an empty box.
 */

/** The newest Emoji version shown (macOS 26 and iOS 26 draw Emoji 16.0). */
export const MAX_VERSION = 16;

/** One emoji as Emojibase's set has it (the fields used here). */
export interface RawEmoji {
  readonly emoji: string;
  readonly label: string;
  readonly group?: number;
  readonly order?: number;
  readonly version?: number;
  readonly tags?: readonly string[];
  readonly shortcodes?: readonly string[];
}

export interface PickerEmoji {
  readonly emoji: string;
  readonly label: string;
  /** Its name, tags and short codes, lowercased: what search looks in. */
  readonly words: string;
}

export interface EmojiCategory {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly emojis: readonly PickerEmoji[];
}

/** Emojibase's groups (their numbers), as the picker names and draws them; 2 (components) is left out. */
const GROUPS: ReadonlyArray<{ readonly group: number; readonly key: string; readonly label: string; readonly icon: IconName }> = [
  { group: 0, key: 'smileys', label: 'Smileys & Emotion', icon: 'smile' },
  { group: 1, key: 'people', label: 'People & Body', icon: 'person' },
  { group: 3, key: 'nature', label: 'Animals & Nature', icon: 'bug' },
  { group: 4, key: 'food', label: 'Food & Drink', icon: 'cup' },
  { group: 5, key: 'travel', label: 'Travel & Places', icon: 'globe' },
  { group: 6, key: 'activities', label: 'Activities', icon: 'star' },
  { group: 7, key: 'objects', label: 'Objects', icon: 'bulb' },
  { group: 8, key: 'symbols', label: 'Symbols', icon: 'heart' },
  { group: 9, key: 'flags', label: 'Flags', icon: 'flag' },
];

const pickerEmoji = (e: RawEmoji): PickerEmoji => ({ emoji: e.emoji, label: e.label, words: [e.label, ...(e.tags ?? []), ...(e.shortcodes ?? [])].join(' ').toLowerCase() });

/** The categories, each in Unicode's order. */
export function categoriesOf(data: readonly RawEmoji[]): EmojiCategory[] {
  return GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    icon: g.icon,
    emojis: data
      .filter((e) => e.group === g.group && (e.version ?? 0) <= MAX_VERSION)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(pickerEmoji),
  })).filter((c) => c.emojis.length);
}

/**
 * Emojis for what you typed: whole words of the name first ("thumbs up" for "thumbs"), then
 * names starting with it, then any tag or short code that has it; shorter names first within
 * each ("red heart" before "heart with arrow"). Empty: none.
 */
export function searchEmojis(categories: readonly EmojiCategory[], query: string, limit = 160): PickerEmoji[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '');
  if (!q) return [];
  const scored: Array<{ e: PickerEmoji; score: number; at: number }> = [];
  let at = 0;
  for (const c of categories) {
    for (const e of c.emojis) {
      at += 1;
      const label = e.label.toLowerCase();
      const score = label === q ? 0 : label.split(/\s+/).some((w) => w === q) ? 1 : label.startsWith(q) ? 2 : label.includes(q) ? 3 : e.words.includes(q) ? 4 : -1;
      if (score >= 0) scored.push({ e, score, at });
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || a.e.label.length - b.e.label.length || a.at - b.at)
    .slice(0, limit)
    .map((s) => s.e);
}

let loading: Promise<EmojiCategory[]> | undefined;

/** Emojibase's set, loaded once (its own chunk: the app doesn't carry it until the picker opens). */
export function loadEmojiCategories(): Promise<EmojiCategory[]> {
  loading ??= import('emojibase-data/en/data.json').then((m) => categoriesOf(m.default as unknown as RawEmoji[]));
  // A failed load can be tried again next time.
  loading.catch(() => (loading = undefined));
  return loading;
}
