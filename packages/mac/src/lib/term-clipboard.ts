import type { Terminal } from '@xterm/xterm';
import { copyText } from './copy.js';
import { getPrefs } from './prefs.js';
import { keyPlatform } from './shortcuts-model.js';
import { OSC_CLIPBOARD, canReadClipboard, clipboardChord, osc52Text, readClipboard } from './term-clipboard-model.js';

export { canReadClipboard };

export const copySelection = (term: Terminal): void => {
  if (!term.hasSelection()) return;
  void copyText(term.getSelection()).catch(() => undefined);
};

export const pasteClipboard = (term: Terminal): void => {
  if (!canReadClipboard()) return;
  void readClipboard().then((text) => text && term.paste(text), () => undefined);
};

export const clipboardKey = (e: KeyboardEvent, term: Terminal): boolean | undefined => {
  const chord = clipboardChord(e, keyPlatform() === 'mac');
  if (!chord) return undefined;
  if (e.type !== 'keydown') return false;
  if (chord === 'paste' && !canReadClipboard()) return false;
  e.preventDefault();
  if (chord === 'copy') copySelection(term);
  else pasteClipboard(term);
  return false;
};

export const attachTermClipboard = (term: Terminal, el: HTMLElement): (() => void) => {
  const osc = term.parser.registerOscHandler(OSC_CLIPBOARD, (data) => {
    const text = osc52Text(data);
    if (text) void copyText(text).catch(() => undefined);
    return true;
  });
  const handleMouseUp = (e: MouseEvent): void => {
    if (e.button !== 0 || !getPrefs().termCopyOnSelect) return;
    copySelection(term);
  };
  el.addEventListener('mouseup', handleMouseUp);
  return () => {
    osc.dispose();
    el.removeEventListener('mouseup', handleMouseUp);
  };
};
