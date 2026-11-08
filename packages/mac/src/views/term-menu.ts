import type { Terminal } from '@xterm/xterm';
import type { ActionItem } from '../components/SpecMenu.js';
import { getPrefs, setPrefs } from '../lib/prefs.js';
import { keyPlatform } from '../lib/shortcuts-model.js';
import { canReadClipboard, copySelection, pasteClipboard } from '../lib/term-clipboard.js';

type TermKeys = { readonly copy: string; readonly paste: string; readonly selectAll?: string };

const MAC_KEYS: TermKeys = { copy: '⌘C', paste: '⌘V', selectAll: '⌘A' };
const OTHER_KEYS: TermKeys = { copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V' };

export const termMenu = (getTerm: () => Terminal | undefined): (() => ActionItem[]) => () => {
  const term = getTerm();
  if (!term) return [];
  const keys = keyPlatform() === 'mac' ? MAC_KEYS : OTHER_KEYS;
  const readable = canReadClipboard();
  const withFocus = (run: () => void) => () => {
    run();
    term.focus();
  };
  return [
    { label: 'Copy', icon: 'copy', keys: keys.copy, disabled: !term.hasSelection(), onSelect: withFocus(() => copySelection(term)) },
    {
      label: 'Paste',
      keys: keys.paste,
      disabled: !readable,
      ...(readable ? {} : { hint: `This page can’t read the clipboard. Press ${keys.paste}.` }),
      onSelect: withFocus(() => pasteClipboard(term)),
    },
    { label: 'Select All', ...(keys.selectAll ? { keys: keys.selectAll } : {}), onSelect: withFocus(() => term.selectAll()) },
    { label: 'Clear', separate: true, onSelect: withFocus(() => term.clear()) },
    { label: 'Copy on Select', checked: getPrefs().termCopyOnSelect, onSelect: () => setPrefs({ termCopyOnSelect: !getPrefs().termCopyOnSelect }) },
  ];
};
