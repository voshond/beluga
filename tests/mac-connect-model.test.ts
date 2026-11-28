import { describe, expect, it } from 'vitest';
import { STARTING_GRACE_MS, STARTING_LINGERS_MS, connectNote, connectTitle, connectViewOf } from '../packages/mac/src/lib/connect-model.js';

// Starting Beluga takes a while, and an attempt that fails or times out meanwhile is normal: the
// window must not say "Beluga isn't running" with a reason and Try again while it simply starts.
describe('what the window says before it is attached', () => {
  it('is starting while the first attempt is on its way', () => {
    expect(connectViewOf({ failed: false, waitedMs: 0, wasConnected: false })).toBe('starting');
  });

  it('is still starting when an attempt failed during an ordinary start', () => {
    expect(connectViewOf({ failed: true, waitedMs: 500, wasConnected: false })).toBe('starting');
    // The window's own 15 s wait for an answer ran out: still no problem.
    expect(connectViewOf({ failed: true, waitedMs: 15_000, wasConnected: false })).toBe('starting');
    expect(connectViewOf({ failed: true, waitedMs: STARTING_GRACE_MS - 1, wasConnected: false })).toBe('starting');
  });

  it('says it is slow only once it has really taken long and an attempt failed', () => {
    expect(connectViewOf({ failed: true, waitedMs: STARTING_GRACE_MS, wasConnected: false })).toBe('slow');
    expect(connectViewOf({ failed: false, waitedMs: STARTING_GRACE_MS * 2, wasConnected: false })).toBe('starting');
  });

  it('is reconnecting, not starting, when Beluga was here and went away', () => {
    expect(connectViewOf({ failed: false, waitedMs: 0, wasConnected: true })).toBe('reconnecting');
    expect(connectViewOf({ failed: true, waitedMs: 5000, wasConnected: true })).toBe('reconnecting');
    expect(connectViewOf({ failed: true, waitedMs: STARTING_GRACE_MS, wasConnected: true })).toBe('slow');
  });

  it('never words waiting as a problem', () => {
    for (const title of [connectTitle('starting', false), connectTitle('reconnecting', true)]) expect(title).not.toMatch(/isn’t|didn't|not running|problem|longer/i);
    expect(connectTitle('slow', false)).toMatch(/longer than usual to start/);
    expect(connectTitle('slow', true)).toMatch(/longer than usual to come back/);
  });

  it('adds one calm line once the wait is noticeable, and what to do once it is slow', () => {
    expect(connectNote('starting', 0)).toBeUndefined();
    expect(connectNote('starting', STARTING_LINGERS_MS - 1)).toBeUndefined();
    expect(connectNote('starting', STARTING_LINGERS_MS)).toMatch(/little while/);
    expect(connectNote('reconnecting', STARTING_LINGERS_MS)).toMatch(/little while/);
    expect(connectNote('slow', STARTING_GRACE_MS)).toMatch(/^Still trying/);
  });
});
