import { describe, expect, it } from 'vitest';
import { type InitiativeView, type Suggestion, initiativeChatChannel } from '../src/core/initiatives/model.js';
import { isQuietInitiative, openSuggestionTotal, sidebarInitiatives } from '../packages/mac/src/initiatives/initiatives-sidebar.js';

const item = (slug: string, patch: Partial<InitiativeView> = {}): InitiativeView => ({
  slug,
  folder: `/tmp/${slug}`,
  name: slug,
  goal: '',
  status: 'active',
  epics: [],
  slack: [],
  docs: [],
  repos: [],
  meetings: [],
  people: [],
  suggestions: [],
  outbox: [],
  artifacts: [],
  timeline: [],
  files: [],
  chats: { chats: [{ id: 'main', channel: initiativeChatChannel(slug, 'main'), createdAt: 0 }], active: 'main' },
  ...patch,
});

const suggestion = (id: number, state: Suggestion['state']): Suggestion => ({ id, text: `s${id}`, kind: 'task', state });

describe('the sidebar’s initiatives', () => {
  it('lists every initiative but the archived ones, live first, then by name', () => {
    const rows = sidebarInitiatives([item('zeta'), item('old', { status: 'archived' }), item('done', { status: 'shipped' }), item('alpha', { status: 'paused' })]);
    expect(rows.map((r) => r.slug)).toEqual(['alpha', 'zeta', 'done']);
  });

  it('gives each row its bar, its open suggestions and the chat it opens in', () => {
    const [row] = sidebarInitiatives([item('checkout', { progress: { at: '2026-11-26T00:00:00.000Z', total: 20, done: 10, inProgress: 5, blocked: 0, stale: 0, epics: [] }, suggestions: [suggestion(1, 'open'), suggestion(2, 'approved'), suggestion(3, 'open')] })]);
    expect(row).toMatchObject({ done: 50, inProgress: 25, asks: 2, chat: 'main', detail: '10 of 20 done' });
  });

  it('says a quiet initiative’s status in its detail', () => {
    const [row] = sidebarInitiatives([item('later', { status: 'paused' })]);
    expect(row!.detail).toBe('Paused · No check-in yet');
    expect(isQuietInitiative('paused')).toBe(true);
    expect(isQuietInitiative('shipped')).toBe(true);
    expect(isQuietInitiative('active')).toBe(false);
  });

  it('adds up the open suggestions for the header', () => {
    expect(openSuggestionTotal([{ asks: 2 }, { asks: 0 }, { asks: 3 }])).toBe(5);
  });
});
