import { describe, expect, it } from 'vitest';
import { checkDeviceName, checkServerUrl } from '../packages/mac/src/connect/server-url.js';

/** The connect page's address rule (BLG-51), the same one src-tauri/src/remote.rs enforces. */
describe('checkServerUrl', () => {
  it('takes https, with or without the scheme, and keeps a join link whole', () => {
    expect(checkServerUrl(' beluga.example.com ')).toEqual({ ok: true, origin: 'https://beluga.example.com', url: 'https://beluga.example.com/' });
    expect(checkServerUrl('https://box.example.com/join/abc')).toMatchObject({ ok: true, origin: 'https://box.example.com', url: 'https://box.example.com/join/abc' });
  });

  it('takes plain http only on this computer (an SSH tunnel)', () => {
    expect(checkServerUrl('http://127.0.0.1:7420')).toMatchObject({ ok: true, origin: 'http://127.0.0.1:7420' });
    expect(checkServerUrl('http://localhost:7420').ok).toBe(true);
    expect(checkServerUrl('http://[::1]:7420').ok).toBe(true);
    expect(checkServerUrl('http://i9arch:7420')).toMatchObject({ ok: false, error: expect.stringContaining('https://') });
    expect(checkServerUrl('http://192.168.2.125')).toMatchObject({ ok: false, error: expect.stringContaining('https://') });
  });

  it('refuses the rest with a message that says why', () => {
    expect(checkServerUrl('')).toMatchObject({ ok: false, error: expect.stringContaining('Enter') });
    expect(checkServerUrl('ftp://box.example.com')).toMatchObject({ ok: false, error: expect.stringContaining('Only https') });
    expect(checkServerUrl('https://me:pw@box.example.com')).toMatchObject({ ok: false, error: expect.stringContaining('sign in') });
    expect(checkServerUrl('https://')).toMatchObject({ ok: false, error: expect.stringContaining('web address') });
  });
});

describe('checkDeviceName', () => {
  it('wants a short single line', () => {
    expect(checkDeviceName(' arch ')).toBeNull();
    expect(checkDeviceName(' ')).toContain('name');
    expect(checkDeviceName('a\tb')).toContain('line breaks');
    expect(checkDeviceName('x'.repeat(65))).toContain('64');
  });
});
