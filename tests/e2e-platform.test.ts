import { afterEach, describe, expect, it } from 'vitest';
import { type E2ePlatform, NAVIGATOR_PLATFORMS, e2ePlatform, pageUserAgent } from '../packages/mac/e2e/platform.js';
import { computerKindOf } from '../src/shared/assistant.js';

/** The Mac e2e's page says which computer it's on (BLG-72): the app's own detection must read it so. */

const keyboardOf = (ua: string): string => (/Mac|iPhone|iPad/.test(ua) ? 'mac' : /Win/.test(ua) ? 'windows' : 'linux');

afterEach(() => {
  delete process.env.E2E_PLATFORM;
});

describe('the e2e page platform', () => {
  it('is a Mac unless the run asks for another', () => {
    expect(e2ePlatform()).toBe('mac');
    process.env.E2E_PLATFORM = 'linux';
    expect(e2ePlatform()).toBe('linux');
    process.env.E2E_PLATFORM = 'beos';
    expect(e2ePlatform()).toBe('mac');
  });

  it.each(['mac', 'linux', 'windows'] as E2ePlatform[])('%s reads as %s for the keyboard and the computer name', (platform) => {
    const page = `${NAVIGATOR_PLATFORMS[platform]} ${pageUserAgent(platform)}`;
    expect(keyboardOf(page)).toBe(platform);
    expect(computerKindOf(page)).toBe(platform);
  });
});
