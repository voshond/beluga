/**
 * Which computer the app's page believes it runs on (lib/shortcuts-model.ts keyPlatform reads the
 * page's user agent). The specs are a Mac's: ⌘ shortcuts, "Your Mac", Finder, macOS sheets. So the
 * page says so on any host, and the run is the same on a Mac and on Linux (BLG-72). E2E_PLATFORM=linux
 * or windows runs the page as that keyboard instead, for specs written to check it.
 */

export type E2ePlatform = 'mac' | 'linux' | 'windows';

const AGENTS: Readonly<Record<E2ePlatform, string>> = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

export const e2ePlatform = (): E2ePlatform => {
  const asked = process.env.E2E_PLATFORM;
  return asked === 'linux' || asked === 'windows' ? asked : 'mac';
};

/** navigator.platform for each: the computer's name ("Your Mac", shared/assistant.ts) reads it before the user agent. */
export const NAVIGATOR_PLATFORMS: Readonly<Record<E2ePlatform, string>> = { mac: 'MacIntel', linux: 'Linux x86_64', windows: 'Win32' };

/** The page's user agent for the run's platform. */
export const pageUserAgent = (platform: E2ePlatform = e2ePlatform()): string => AGENTS[platform];

/**
 * Native editing keys in a plain text field follow the host's own browser, not the page's platform:
 * the end of the text is ⌘↓ on a Mac, Ctrl+End elsewhere.
 */
export const TEXT_END = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

/** The page's main modifier for its own shortcuts (⌘ on the Mac page): Playwright's ControlOrMeta follows the host instead. */
export const MOD = e2ePlatform() === 'mac' ? 'Meta' : 'Control';
