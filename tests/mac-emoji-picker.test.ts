import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_VERSION, type RawEmoji, categoriesOf, searchEmojis } from '../packages/mac/src/network/emoji-data.js';

/** The Mac's full emoji picker (BLG-702): Emojibase's set, in categories, searched by name. */

const data = JSON.parse(readFileSync(new URL('../packages/mac/node_modules/emojibase-data/en/data.json', import.meta.url), 'utf8')) as RawEmoji[];
const categories = categoriesOf(data);

describe('the emoji picker’s data', () => {
  it('has the nine categories in order, each emoji once, without the building blocks', () => {
    expect(categories.map((c) => c.key)).toEqual(['smileys', 'people', 'nature', 'food', 'travel', 'activities', 'objects', 'symbols', 'flags']);
    const all = categories.flatMap((c) => c.emojis.map((e) => e.emoji));
    expect(all.length).toBeGreaterThan(1500);
    expect(new Set(all).size).toBe(all.length);
    expect(categories[0]?.emojis[0]?.emoji).toBe('😀');
    // Regional letters and bare skin tones aren't reactions of their own.
    expect(all).not.toContain('🇦');
    expect(all).not.toContain('🏽');
    expect(all).toContain('🇹🇷');
    // Newer than today's Macs draw: left out (🫫 is Emoji 18).
    expect(MAX_VERSION).toBe(16);
    expect(all).not.toContain('🫫');
    expect(all).toContain('🫠');
  });

  it('finds by name first, then by tag or short code', () => {
    expect(searchEmojis(categories, 'thumbs')[0]?.emoji).toBe('👍');
    expect(searchEmojis(categories, ':tada:').map((e) => e.emoji)).toContain('🎉');
    expect(searchEmojis(categories, 'heart').slice(0, 3).map((e) => e.emoji)).toContain('❤️');
    expect(searchEmojis(categories, 'eyes')[0]?.emoji).toBe('👀');
    expect(searchEmojis(categories, '   ')).toEqual([]);
    expect(searchEmojis(categories, 'zzzznotanemoji')).toEqual([]);
    expect(searchEmojis(categories, 'a', 10)).toHaveLength(10);
  });
});
