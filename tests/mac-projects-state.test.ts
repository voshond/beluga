import { describe, expect, it } from 'vitest';
import { initialState, reduceDomain } from '../src/core/store.js';
import { LOADING_SHOWS_AFTER_MS, nextViewChangeIn, projectsStateOf, projectsViewOf, stillLoading } from '../packages/mac/src/lib/projects-state-model.js';

// A window attaches while Beluga is still scanning the project folders: no projects then means
// "not known yet", and nothing should say "add a project" until the scan is done.
const project = { root: '/code/app' };
const chats = { root: '' };

describe('whether this computer has projects', () => {
  it('is loading until the first scan is done', () => {
    expect(projectsStateOf({ projects: [], projectsLoaded: false })).toBe('loading');
  });

  it('is empty once Beluga looked and found none', () => {
    expect(projectsStateOf({ projects: [], projectsLoaded: true })).toBe('empty');
  });

  it('is ready as soon as a project is here, whatever the scan says', () => {
    expect(projectsStateOf({ projects: [project], projectsLoaded: false })).toBe('ready');
    expect(projectsStateOf({ projects: [project], projectsLoaded: true })).toBe('ready');
  });

  it('does not count Chats, which has no folder, as a project', () => {
    expect(projectsStateOf({ projects: [chats], projectsLoaded: false })).toBe('loading');
    expect(projectsStateOf({ projects: [chats], projectsLoaded: true })).toBe('empty');
  });

  it('follows the state a daemon really sends: loading at first, empty after its scan', () => {
    const started = initialState('room');
    expect(projectsStateOf(started)).toBe('loading');
    expect(projectsStateOf(reduceDomain(started, { type: 'projects_loaded' }))).toBe('empty');
  });
});

describe('what a place draws while the projects load', () => {
  it('draws nothing in the first moments, so a fast start never flashes', () => {
    expect(projectsViewOf('loading', 0)).toBe('pending');
    expect(projectsViewOf('loading', LOADING_SHOWS_AFTER_MS - 1)).toBe('pending');
  });

  it('shows the loading state after that', () => {
    expect(projectsViewOf('loading', LOADING_SHOWS_AFTER_MS)).toBe('loading');
  });

  it('keeps showing it however long the scan takes, never "add a project" in its place', () => {
    expect(projectsViewOf('loading', 76_000)).toBe('loading');
    expect(projectsViewOf('loading', 3_600_000)).toBe('loading');
  });

  it('shows what is known at once, however long it waited', () => {
    for (const waited of [0, LOADING_SHOWS_AFTER_MS, 3_600_000]) {
      expect(projectsViewOf('ready', waited)).toBe('ready');
      expect(projectsViewOf('empty', waited)).toBe('empty');
    }
  });

  it('knows when to look again: at each change, and never once it is settled', () => {
    expect(nextViewChangeIn('loading', 0)).toBe(LOADING_SHOWS_AFTER_MS);
    expect(nextViewChangeIn('loading', 100)).toBe(LOADING_SHOWS_AFTER_MS - 100);
    expect(nextViewChangeIn('loading', LOADING_SHOWS_AFTER_MS)).toBeUndefined();
    expect(nextViewChangeIn('ready', 0)).toBeUndefined();
    expect(nextViewChangeIn('empty', 0)).toBeUndefined();
    // Each wait ends in a different answer than the one before it.
    const first = nextViewChangeIn('loading', 0)!;
    expect(projectsViewOf('loading', first)).not.toBe(projectsViewOf('loading', 0));
  });

  it('says nothing about there being no projects while loading or pending', () => {
    expect(stillLoading('pending')).toBe(true);
    expect(stillLoading('loading')).toBe(true);
    expect(stillLoading('empty')).toBe(false);
    expect(stillLoading('ready')).toBe(false);
  });
});
