import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, chatWidthOf } from '../packages/mac/src/lib/prefs.js';

describe('conversation width (BLG-697)', () => {
  it('is the full window by default', () => {
    expect(DEFAULT_PREFS.chatWidth).toBe('full');
    expect(chatWidthOf(DEFAULT_PREFS)).toBe('full');
  });

  it('moves a Wide saved as the old default to the full window', () => {
    expect(chatWidthOf({ ...DEFAULT_PREFS, chatWidth: 'wide' })).toBe('full');
  });

  it('keeps a width you picked', () => {
    expect(chatWidthOf({ ...DEFAULT_PREFS, chatWidth: 'wide', chatWidthPicked: true })).toBe('wide');
    expect(chatWidthOf({ ...DEFAULT_PREFS, chatWidth: 'narrow' })).toBe('narrow');
  });

  it('falls back to the full window on anything else', () => {
    expect(chatWidthOf({ ...DEFAULT_PREFS, chatWidth: 'huge' as never })).toBe('full');
  });
});
