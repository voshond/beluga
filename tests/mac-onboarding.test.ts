import { describe, expect, it } from 'vitest';
import { ACCESS, DONE_KEY, LAST_SETTING, PLACE_KEY, PREFS_KEY, RESUME_MS, STEPS, TOUR, accessPlace, afterAccess, afterTour, clearPlace, groupOf, inAccess, inTour, resumeAt, saveMark, savePlace, shouldShow, stepBy, tourPlace, wasDone } from '../packages/mac/src/onboarding/onboarding-model.js';
import { ACCESS_COPY, accessNext, grantText } from '../packages/mac/src/onboarding/access-copy.js';
import { TOUR_SENTINELS } from '../packages/mac/src/onboarding/sentinel-tour.js';
import { TOUR_COPY } from '../packages/mac/src/onboarding/tour-copy.js';
import { accessAllows, stepAvailable, triggerAvailable } from '../src/core/sentinel/model.js';

/** The Mac app's first-run welcome (packages/mac/src/onboarding): when it shows, and how it steps. */

const memory = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
};

describe('when the welcome shows', () => {
  it('shows on a fresh install', () => {
    expect(shouldShow(memory())).toBe(true);
  });

  it('never shows to someone who used Beluga before it existed', () => {
    expect(shouldShow(memory({ [PREFS_KEY]: '{}' }))).toBe(false);
  });

  it('stays away once finished or skipped, whatever version is installed next', () => {
    const store = memory();
    saveMark(store, '0.6.3', 'finished');
    expect(shouldShow(store)).toBe(false);
    saveMark(store, '0.6.3', 'skipped');
    expect(shouldShow(store)).toBe(false);
  });

  it('comes back after quitting halfway, even though picking a theme wrote preferences', () => {
    const store = memory({ [PREFS_KEY]: '{"appearance":"dark"}' });
    saveMark(store, '0.6.3', 'started');
    expect(shouldShow(store)).toBe(true);
  });

  it('shows when asked with ?welcome', () => {
    const store = memory();
    saveMark(store, '1.0.0', 'finished');
    expect(shouldShow(store, '?welcome')).toBe(true);
  });

  it('treats an unreadable mark as done, and storage that throws as nothing to show', () => {
    expect(shouldShow(memory({ [DONE_KEY]: 'not json' }))).toBe(false);
    expect(shouldShow({ getItem: () => { throw new Error('off'); }, setItem: () => undefined })).toBe(false);
  });

  it('keeps what it saved: the version, when, and how', () => {
    const store = memory();
    expect(saveMark(store, '0.7.0', 'finished', 42)).toEqual({ version: '0.7.0', at: 42, how: 'finished' });
    expect(JSON.parse(store.data.get(DONE_KEY)!)).toEqual({ version: '0.7.0', at: 42, how: 'finished' });
    expect(() => saveMark({ getItem: () => null, setItem: () => { throw new Error('full'); } }, '1', 'finished')).not.toThrow();
  });
});

describe('coming back after macOS asks to quit and reopen', () => {
  const MIN = 60 * 1000;

  it('opens the first run where it was left, not at the welcome', () => {
    const store = memory();
    saveMark(store, '0.18.0', 'started');
    savePlace(store, 'screen', 0);
    expect(shouldShow(store, '', 2 * 24 * 60 * MIN)).toBe(true);
    expect(resumeAt(store, 2 * 24 * 60 * MIN)).toBe('screen');
  });

  it('brings a replay back to a permission step left a few minutes ago, and only that', () => {
    const store = memory();
    saveMark(store, '0.18.0', 'finished');
    savePlace(store, 'accessibility', 0);
    expect(shouldShow(store, '', 2 * MIN)).toBe(true);
    expect(resumeAt(store, 2 * MIN)).toBe('accessibility');
    expect(shouldShow(store, '', RESUME_MS + MIN)).toBe(false);
    savePlace(store, 'agents', 0);
    expect(shouldShow(store, '', MIN)).toBe(false);
    expect(wasDone(store)).toBe(true);
  });

  it('starts from the welcome once finished or skipped, or with nothing worth coming back to', () => {
    const store = memory();
    savePlace(store, 'disk', 0);
    saveMark(store, '0.18.0', 'skipped');
    clearPlace(store);
    expect(resumeAt(store, MIN)).toBeUndefined();
    expect(shouldShow(store, '', MIN)).toBe(false);
    expect(resumeAt(memory({ [PLACE_KEY]: '{"step":"nowhere","at":0}' }))).toBeUndefined();
    expect(resumeAt(memory({ [PLACE_KEY]: 'not json' }))).toBeUndefined();
  });
});

describe('stepping through it', () => {
  it('goes from the welcome through the tour to the settings and the end', () => {
    expect(STEPS[0]).toBe('hello');
    expect(STEPS.at(-1)).toBe('ready');
    expect(stepBy('hello', 1)).toBe('yourAgents');
    expect(stepBy('yourAgents', 1)).toBe('parallel');
    expect(stepBy('hello', -1)).toBe('hello');
    expect(stepBy('ready', 1)).toBe('ready');
  });

  it('places the tour steps ("2 of 5") and skips past them to the look', () => {
    expect(TOUR.every(inTour)).toBe(true);
    expect(inTour('setup')).toBe(false);
    expect(tourPlace('agents')).toEqual({ at: 2, of: TOUR.length });
    expect(tourPlace('look')).toBeUndefined();
    expect(afterTour()).toBe('look');
    expect(STEPS.indexOf(afterTour())).toBe(STEPS.indexOf(TOUR.at(-1)!) + 1);
  });
});

describe('the permission steps', () => {
  it('asks for each permission on its own step, after the settings and before notifications', () => {
    expect(ACCESS).toEqual(['screen', 'accessibility', 'disk', 'automation']);
    expect(STEPS.indexOf('setup') + 1).toBe(STEPS.indexOf(ACCESS[0]));
    expect(STEPS.indexOf(ACCESS.at(-1)!) + 1).toBe(STEPS.indexOf('popups'));
    expect(ACCESS.every(inAccess)).toBe(true);
    expect(inAccess('popups')).toBe(false);
    expect(accessPlace('disk')).toEqual({ at: 3, of: 4 });
    expect(accessPlace('look')).toBeUndefined();
  });

  it('lets every one be skipped: Not Now passes on one, Skip Permissions on all of them', () => {
    expect(accessNext(undefined)).toBe('Not Now');
    expect(accessNext('off')).toBe('Not Now');
    expect(accessNext('unknown')).toBe('Not Now');
    expect(accessNext('granted')).toBe('Continue');
    expect(afterAccess()).toBe('popups');
    for (const a of ACCESS) expect(stepBy(a, 1)).not.toBe('ready');
  });

  it('says why each may be useful in one sentence, and opens its own pane', () => {
    for (const a of ACCESS) {
      const copy = ACCESS_COPY[a];
      expect(copy.pane).toBe(a);
      expect(copy.why.trim().split(/(?<=[.!?])\s+(?=[A-Z])/)).toHaveLength(1);
      expect(copy.why.endsWith('.')).toBe(true);
    }
  });

  it('shows how each stands', () => {
    expect(grantText('granted', false)).toBe('Allowed');
    expect(grantText('off', false)).toBe('Not allowed yet');
    expect(grantText('off', true)).toMatch(/System Settings/);
    expect(grantText('unknown', false)).toBe('Optional');
  });
});

describe('the new tour and phone steps', () => {
  it('shows the table weave in the tour, right after the live agents', () => {
    expect(TOUR).toContain('tables');
    expect(stepBy('agents', 1)).toBe('tables');
    expect(tourPlace('tables')).toEqual({ at: 3, of: TOUR.length });
  });

  it('ends on the phone (its button says Finish), then the last step', () => {
    expect(LAST_SETTING).toBe('phone');
    expect(stepBy('popups', 1)).toBe('phone');
    expect(stepBy('phone', 1)).toBe('ready');
  });

  it('groups the dots: the tour, the permissions, the rest', () => {
    expect(groupOf('agents')).toBe('tour');
    expect(groupOf('automation')).toBe('access');
    expect(groupOf('phone')).toBe('other');
  });
});

describe('Sentinel in the tour (BLG-362)', () => {
  it('explains a sentinel, then shows it at work, right after friends', () => {
    expect(stepBy('friends', 1)).toBe('sentinel');
    expect(stepBy('sentinel', 1)).toBe('uses');
    expect(stepBy('uses', 1)).toBe('archive');
    expect(inTour('sentinel') && inTour('uses')).toBe(true);
    expect(TOUR_COPY.sentinel?.title).toBeTruthy();
    expect(TOUR_COPY.uses?.title).toBeTruthy();
  });

  it('builds only sentinels Sentinel really allows', () => {
    expect(new Set(TOUR_SENTINELS.map((x) => x.id)).size).toBe(TOUR_SENTINELS.length);
    // Different triggers and steps each time: the point is how far the same parts go.
    expect(new Set(TOUR_SENTINELS.map((x) => x.trigger)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(TOUR_SENTINELS.flatMap((x) => x.steps.map((st) => st.kind))).size).toBeGreaterThanOrEqual(7);
    for (const x of TOUR_SENTINELS) {
      expect(triggerAvailable(x.trigger)).toBe(true);
      expect(x.said).toHaveLength(3);
      expect(x.steps.length).toBeGreaterThan(0);
      for (const st of x.steps) {
        expect(stepAvailable(st.kind)).toBe(true);
        expect(accessAllows(x.access, st.kind, st.where), `${x.id}: ${st.kind} with ${x.access}`).toBe(true);
      }
    }
  });
});
