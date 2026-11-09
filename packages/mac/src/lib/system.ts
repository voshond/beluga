import { inApp } from './boot.js';
import { keyPlatform, primaryLabel } from './shortcuts-model.js';

/** Open a web page in the default browser (or a mailto: link in Mail). */
export async function openExternal(url: string): Promise<void> {
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return;
  if (inApp()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener');
}

/** On a Mac (as the keyboard shortcuts see it: keyPlatform). */
export const isMac = (): boolean => keyPlatform() === 'mac';
/** The main modifier's name: ⌘, or Ctrl off a Mac. For a whole chord ("⌘↩", "Ctrl+Enter") use chordLabel. */
export const mod = (): string => primaryLabel();
