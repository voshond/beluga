import { afterEach, describe, expect, it, vi } from 'vitest';

const readText = vi.fn(async () => 'from the app');
vi.mock('../packages/mac/node_modules/@tauri-apps/plugin-clipboard-manager/dist-js/index.js', () => ({ readText }));

const { canReadClipboard, readClipboard } = await import('../packages/mac/src/lib/term-clipboard-model.js');

describe('a terminal’s paste', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    readText.mockClear();
  });

  it('reads the app’s own clipboard in the client, where the page’s clipboard can’t be read', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'beluga.example' });
    vi.stubGlobal('navigator', {});
    expect(canReadClipboard()).toBe(true);
    await expect(readClipboard()).resolves.toBe('from the app');
    expect(readText).toHaveBeenCalledOnce();
  });

  it('reads the page’s clipboard in a browser', async () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'beluga.example' });
    vi.stubGlobal('navigator', { clipboard: { readText: async () => 'from the page' } });
    expect(canReadClipboard()).toBe(true);
    await expect(readClipboard()).resolves.toBe('from the page');
    expect(readText).not.toHaveBeenCalled();
  });

  it('can’t paste in a browser without a readable clipboard', () => {
    vi.stubGlobal('location', { protocol: 'http:', hostname: '192.168.2.10' });
    vi.stubGlobal('navigator', {});
    expect(canReadClipboard()).toBe(false);
  });
});
