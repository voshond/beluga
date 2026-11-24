import { describe, expect, it } from 'vitest';
import { paceLine, paceOf, worstPressure } from '../src/ui/usage-pace.js';

const HOUR = 3_600_000;
const now = Date.UTC(2026, 10, 24, 12);

describe('usage pace', () => {
  it('projects the 5-hour window at its current rate', () => {
    const pace = paceOf({ label: '5-hour', short: '5h', pct: 40, resetsAt: now + 3 * HOUR }, now);
    expect(pace).toMatchObject({ segments: 5, elapsed: 40, projected: 100, pressure: 'hot' });
    expect(paceLine(pace)).toBe('5-hour: 40% used, on pace to run out before it resets');
  });

  it('keeps a calm week calm', () => {
    const pace = paceOf({ label: 'Weekly', short: 'wk', pct: 20, resetsAt: now + 84 * HOUR }, now);
    expect(pace).toMatchObject({ segments: 7, elapsed: 50, projected: 40, pressure: 'calm' });
    expect(paceLine(pace)).toBe('Weekly: 20% used, on pace for 40% by reset');
  });

  it('waits before projecting a window that just started', () => {
    const pace = paceOf({ label: '5-hour', short: '5h', pct: 3, resetsAt: now + 5 * HOUR - 60_000 }, now);
    expect(pace.projected).toBeUndefined();
    expect(pace.pressure).toBe('calm');
  });

  it('has no projection for a window of unknown length', () => {
    const pace = paceOf({ label: 'Gemini Pro', short: 'gem', pct: 75, resetsAt: now + HOUR }, now);
    expect(pace).toMatchObject({ segments: 0, pressure: 'warm' });
    expect(pace.projected).toBeUndefined();
  });

  it('reports the worst pressure', () => {
    const calm = paceOf({ label: 'Weekly', short: 'wk', pct: 10 }, now);
    const hot = paceOf({ label: '5-hour', short: '5h', pct: 95 }, now);
    expect(worstPressure([calm, hot])).toBe('hot');
    expect(worstPressure([])).toBeUndefined();
  });
});
