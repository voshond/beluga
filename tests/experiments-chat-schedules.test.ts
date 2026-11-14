import { describe, expect, it } from 'vitest';
import { EXPERIMENT_INFO, EXPERIMENTS, experimentGate, experimentOn, withExperiment } from '../src/shared/experiments.js';

describe('chat-schedules experiment', () => {
  it('is listed with its explanation', () => {
    expect(EXPERIMENTS).toContain('chat-schedules');
    expect(EXPERIMENT_INFO['chat-schedules'].title).toBe('Chat schedules');
    expect(EXPERIMENT_INFO['chat-schedules'].changes.length).toBeGreaterThan(0);
  });

  it('is on by default; the switch turns it off, and back on', () => {
    let enabled: string[] | undefined;
    const on = experimentGate(() => enabled, 'chat-schedules');
    expect(on()).toBe(true);
    enabled = [];
    expect(on()).toBe(true);
    enabled = withExperiment([], 'chat-schedules', false);
    expect(on()).toBe(false);
    enabled = withExperiment(enabled, 'chat-schedules', true);
    expect(on()).toBe(true);
    // An old list that turned it on by name keeps it on.
    enabled = ['previews', 'chat-schedules'];
    expect(on()).toBe(true);
  });

  it('turning it off keeps the other experiments as they were', () => {
    const off = withExperiment(['previews'], 'chat-schedules', false);
    expect(experimentOn(off, 'previews')).toBe(true);
    expect(experimentOn(off, 'chat-schedules')).toBe(false);
    expect(withExperiment(off, 'chat-schedules', false)).toEqual(off);
  });

  it('previews stays off until you turn it on', () => {
    expect(experimentOn([], 'previews')).toBe(false);
    expect(experimentOn(withExperiment([], 'previews', true), 'previews')).toBe(true);
  });
});
