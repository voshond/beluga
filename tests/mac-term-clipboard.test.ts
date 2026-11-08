import { describe, expect, it } from 'vitest';
import { clipboardChord, osc52Text } from '../packages/mac/src/lib/term-clipboard-model.js';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('osc52Text', () => {
  it('reads what a program copies', () => {
    expect(osc52Text(`c;${b64('npm run dev')}`)).toBe('npm run dev');
    expect(osc52Text(`;${b64('no target')}`)).toBe('no target');
  });

  it('keeps unicode and line breaks', () => {
    expect(osc52Text(`c;${b64('héllo 🐳\nworld')}`)).toBe('héllo 🐳\nworld');
  });

  it('never answers a read of the clipboard', () => {
    expect(osc52Text('c;?')).toBeUndefined();
  });

  it('ignores empty, malformed or non-text payloads', () => {
    expect(osc52Text('c;')).toBeUndefined();
    expect(osc52Text('nothing')).toBeUndefined();
    expect(osc52Text('c;!!!not-base64')).toBeUndefined();
    expect(osc52Text(`c;${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')}`)).toBeUndefined();
  });
});

describe('clipboardChord', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

  it('takes Ctrl+Shift+C and V off a Mac', () => {
    expect(clipboardChord(key('C', { ctrlKey: true, shiftKey: true }), false)).toBe('copy');
    expect(clipboardChord(key('V', { ctrlKey: true, shiftKey: true }), false)).toBe('paste');
  });

  it('leaves Ctrl+C to the shell and the Mac its own keys', () => {
    expect(clipboardChord(key('c', { ctrlKey: true }), false)).toBeUndefined();
    expect(clipboardChord(key('C', { ctrlKey: true, shiftKey: true }), true)).toBeUndefined();
    expect(clipboardChord(key('C', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBeUndefined();
  });
});
