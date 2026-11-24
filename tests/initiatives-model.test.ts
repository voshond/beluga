import { describe, expect, it } from 'vitest';
import {
  CHECK_IN_CHAT,
  EpicStatusSchema,
  InitiativeConfigSchema,
  InitiativeDraftSchema,
  NO_INITIATIVES,
  type InitiativeView,
  SuggestionsSchema,
  activeInitiativeChat,
  initiativeChatChannel,
  initiativeChatOf,
  initiativeChatTitle,
  openDecisionsOf,
  progressShare,
  recentOf,
  reduceInitiatives,
  slugOf,
  suggestionMessage,
  uniqueSlug,
} from '../src/core/initiatives/model.js';
import { channelOf, initialState, reduceDomain, shownChannel } from '../src/core/store.js';
import { isKnownAction } from '../src/core/known-actions.js';
import { isAddressableChannel, parseChatRef } from '../src/shared/chat-ref.js';
import { Channel } from '../src/protocol.js';

const item = (slug: string, name = slug): InitiativeView => ({
  slug,
  folder: `/tmp/${slug}`,
  name,
  goal: '',
  status: 'active',
  epics: [],
  slackChannels: [],
  docs: [],
  repos: [],
  calendarMatch: '',
  people: [],
  suggestions: [],
  openDecisions: [],
  recent: [],
  files: [],
  chats: { chats: [{ id: 'main', channel: initiativeChatChannel(slug, 'main'), createdAt: 0 }], active: 'main' },
});

describe('initiative slugs', () => {
  it('makes a folder name from the name', () => {
    expect(slugOf('Checkout v2: the Rewrite!')).toBe('checkout-v2-the-rewrite');
    expect(slugOf('Café Ödland')).toBe('cafe-odland');
    expect(slugOf('!!!')).toBe('initiative');
    expect(slugOf('x'.repeat(80))).toHaveLength(40);
  });

  it('never takes one already there', () => {
    expect(uniqueSlug('Checkout', new Set(['checkout']))).toBe('checkout-2');
    expect(uniqueSlug('Checkout', new Set(['checkout', 'checkout-2']))).toBe('checkout-3');
    expect(uniqueSlug('Fresh', new Set(['checkout']))).toBe('fresh');
  });
});

describe('initiative channels', () => {
  it('round-trips a chat’s channel', () => {
    const channel = initiativeChatChannel('checkout-v2', 'main');
    expect(channel).toBe('initiative:checkout-v2:main');
    expect(initiativeChatOf(channel)).toEqual({ slug: 'checkout-v2', chat: 'main' });
    expect(initiativeChatOf('initiative:Bad:main')).toBeUndefined();
    expect(initiativeChatOf('sentinel-chat:main')).toBeUndefined();
  });

  it('is a channel the protocol and chat refs accept, so a sentinel may wake it', () => {
    const channel = initiativeChatChannel('checkout-v2', CHECK_IN_CHAT);
    expect(Channel.safeParse(channel).success).toBe(true);
    expect(isAddressableChannel(channel)).toBe(true);
    expect(parseChatRef(`peer-12345678/${channel}`)).toEqual({ owner: 'peer-12345678', channel });
  });

  it('names the check-in chat, and others by their first line', () => {
    const check = initiativeChatChannel('a', CHECK_IN_CHAT);
    const main = initiativeChatChannel('a', 'main');
    expect(initiativeChatTitle(check, [])).toBe('Check-in');
    expect(initiativeChatTitle(main, [])).toBe('New chat');
    expect(initiativeChatTitle(main, [{ channel: main, type: 'chat', byAgent: false, text: 'Where does this stand?\nmore' }])).toBe('Where does this stand?');
  });

  it('finds the open chat', () => {
    expect(activeInitiativeChat(item('a'))).toBe('initiative:a:main');
  });
});

describe('initiative schemas', () => {
  it('fills in a config’s defaults and refuses a bad epic key', () => {
    const config = InitiativeConfigSchema.parse({ name: 'Checkout' });
    expect(config).toMatchObject({ status: 'active', epics: [], repos: [], goal: '' });
    expect(InitiativeDraftSchema.safeParse({ name: 'X', epics: ['shop-1'] }).success).toBe(false);
    expect(InitiativeDraftSchema.safeParse({ name: 'X', epics: ['SHOP-120'] }).success).toBe(true);
    expect(InitiativeConfigSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('reads status and suggestions the agent writes', () => {
    expect(EpicStatusSchema.parse({ at: '2026-11-24T08:00:00Z', total: 10, done: 4 })).toMatchObject({ inProgress: 0, blocked: 0, stale: 0, epics: [] });
    expect(SuggestionsSchema.parse([{ id: 1, text: 'Ask Ana' }])[0]).toMatchObject({ state: 'open', kind: 'other' });
    expect(SuggestionsSchema.safeParse([{ id: 0, text: 'x' }]).success).toBe(false);
  });

  it('works out the progress share', () => {
    expect(progressShare(undefined)).toBeUndefined();
    expect(progressShare({ at: '', total: 0, done: 0, inProgress: 0, blocked: 0, stale: 0, epics: [] })).toBeUndefined();
    expect(progressShare({ at: '', total: 4, done: 1, inProgress: 0, blocked: 0, stale: 0, epics: [] })).toBe(0.25);
  });

  it('says an approved suggestion as a message', () => {
    expect(suggestionMessage({ id: 3, text: 'Comment on SHOP-150' })).toBe('Do suggestion 3: Comment on SHOP-150');
  });
});

describe('initiative memory parsing', () => {
  it('reads the open decisions only', () => {
    const md = '# Decisions\n\n## Open\n\n- Launch in NO?\n- [ ] Guest checkout flag?\n\n## Decided\n\n- 2026-11-20: Apple Pay first\n';
    expect(openDecisionsOf(md)).toEqual(['Launch in NO?', 'Guest checkout flag?']);
    expect(openDecisionsOf('# Decisions\n')).toEqual([]);
  });

  it('reads the newest timeline lines', () => {
    const md = `# Timeline\n\n${Array.from({ length: 12 }, (_, i) => `- line ${i}`).join('\n')}\n`;
    expect(recentOf(md)).toHaveLength(8);
    expect(recentOf(md)[0]).toBe('line 0');
  });
});

describe('the initiatives slice', () => {
  it('starts off, then takes init, put, remove and off', () => {
    let slice = { initiatives: NO_INITIATIVES };
    slice = reduceInitiatives(slice, { type: 'initiatives_init', state: { enabled: true, root: '/r', items: [item('a')] } });
    slice = reduceInitiatives(slice, { type: 'initiative_put', item: item('b') });
    slice = reduceInitiatives(slice, { type: 'initiative_put', item: item('a', 'Renamed') });
    expect(slice.initiatives.items.map((i) => i.name)).toEqual(['Renamed', 'b']);
    slice = reduceInitiatives(slice, { type: 'initiative_remove', slug: 'b' });
    expect(slice.initiatives.items.map((i) => i.slug)).toEqual(['a']);
    expect(reduceInitiatives(slice, { type: 'initiatives_off' }).initiatives).toEqual(NO_INITIATIVES);
  });

  it('is in the domain state, its actions known, its page a conversation', () => {
    const state = reduceDomain(initialState('room'), { type: 'initiative_put', item: item('a') });
    expect(state.initiatives.items).toHaveLength(1);
    for (const type of ['initiatives_init', 'initiative_put', 'initiative_remove', 'initiatives_off']) expect(isKnownAction(type)).toBe(true);
    expect(channelOf({ kind: 'initiative_page', slug: 'a', chat: 'checkin' })).toBe('initiative:a:checkin');
    expect(channelOf({ kind: 'initiative_page', slug: 'a' })).toBe('initiative:a:main');
    expect(shownChannel({ kind: 'initiative_page', slug: 'a' })).toBe('initiative:a:main');
    expect(shownChannel({ kind: 'initiatives' })).toBeUndefined();
  });
});
