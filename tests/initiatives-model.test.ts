import { describe, expect, it } from 'vitest';
import {
  CHECK_IN_CHAT,
  EpicStatusSchema,
  InitiativeConfigSchema,
  InitiativeDraftSchema,
  NO_INITIATIVES,
  type InitiativeView,
  SuggestionsSchema,
  TicketsSchema,
  confluencePageIdOf,
  docKindOf,
  googleFileIdOf,
  linkOf,
  meetingKindOf,
  sameKeys,
  slackKindOf,
  sortedTickets,
  ticketGroups,
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
  decisionMessage,
  isDecision,
  isSendingTool,
  matchesDraft,
  sendDraftMessage,
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
  slack: [],
  docs: [],
  repos: [],
  meetings: [],
  people: [],
  suggestions: [],
  outbox: [],
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

  it('knows a sending tool and the one call a draft allows', () => {
    expect(['mcp__plugin_slack_slack__slack_send_message', 'mcp__slack__slack_schedule_message', 'mcp__jira__jira_add_comment', 'slack_send_message'].map(isSendingTool)).toEqual([true, true, true, true]);
    expect(['mcp__plugin_slack_slack__slack_send_message_draft', 'mcp__jira__jira_get_issue', 'Bash'].map(isSendingTool)).toEqual([false, false, false]);
    const thread = { kind: 'slack', channel: 'D1', thread: '17.5' } as const;
    expect(matchesDraft(thread, 'hi', 'mcp__x__slack_send_message', { channel_id: 'D1', thread_ts: '17.5', message: ' hi\n' })).toBe(true);
    expect(matchesDraft(thread, 'hi', 'mcp__x__slack_send_message', { channel_id: 'D1', message: 'hi' })).toBe(false);
    expect(matchesDraft({ kind: 'jira', issue: 'RUN-1' }, 'ok', 'mcp__x__slack_send_message', { channel_id: 'RUN-1', message: 'ok' })).toBe(false);
    expect(sendDraftMessage({ id: 4, to: { kind: 'jira', issue: 'RUN-1' } }, 'ok')).toBe('Send draft 4 from the outbox now: jira_add_comment with issue_key RUN-1, and the body exactly as below, nothing added or changed.\n\nok');
  });

  it('tells a decision from a suggestion, and says what was decided', () => {
    expect([isDecision({ kind: 'decision' }), isDecision({ kind: 'jira', options: ['Yes', 'No'] }), isDecision({ kind: 'jira', options: [] }), isDecision({ kind: 'slack' })]).toEqual([true, true, false, false]);
    expect(decisionMessage({ id: 2, text: 'Are Sale Orders in scope?' }, 'Yes')).toBe('Decided suggestion 2: Are Sale Orders in scope?\nAnswer: Yes');
  });
});

describe('what an initiative follows', () => {
  it('takes Slack conversations and meetings as lists, each with an optional label', () => {
    const config = InitiativeConfigSchema.parse({
      name: 'A',
      slack: [{ ref: '#checkout' }, { ref: 'https://acme.slack.com/archives/C01ABC/p1763990000000100', label: 'Vendor thread' }],
      meetings: [{ match: 'Checkout' }, { match: 'https://calendar.google.com/calendar/event?eid=abc', label: 'Go/no-go' }],
    });
    expect(config.slack).toEqual([{ ref: '#checkout' }, { ref: 'https://acme.slack.com/archives/C01ABC/p1763990000000100', label: 'Vendor thread' }]);
    expect(config.meetings).toHaveLength(2);
    expect(InitiativeConfigSchema.safeParse({ name: 'A', slack: [{ ref: `https://x.slack.com/${'a'.repeat(500)}` }] }).success).toBe(false);
    expect(InitiativeDraftSchema.parse({ name: 'A', slack: [{ ref: '#a' }], meetings: [{ match: 'Sync' }] })).toMatchObject({ slack: [{ ref: '#a' }], meetings: [{ match: 'Sync' }] });
  });

  it('migrates an old file’s slackChannels and calendarMatch on read, and writes the new shape', () => {
    const old = InitiativeConfigSchema.parse({ name: 'A', goal: 'g', slackChannels: ['#checkout', ' #pay '], calendarMatch: 'Checkout', people: [], docs: [], repos: [] });
    expect(old.slack).toEqual([{ ref: '#checkout' }, { ref: '#pay' }]);
    expect(old.meetings).toEqual([{ match: 'Checkout' }]);
    expect(Object.keys(old)).not.toContain('slackChannels');
    expect(Object.keys(old)).not.toContain('calendarMatch');
    expect(InitiativeConfigSchema.parse(JSON.parse(JSON.stringify(old)))).toEqual(old);
    expect(InitiativeConfigSchema.parse({ name: 'A', slackChannels: ['#old'], slack: [], calendarMatch: '' })).toMatchObject({ slack: [], meetings: [] });
  });

  it('keeps a goal of up to 12000 characters', () => {
    expect(InitiativeConfigSchema.parse({ name: 'A', goal: 'x'.repeat(12_000) }).goal).toHaveLength(12_000);
    expect(InitiativeConfigSchema.safeParse({ name: 'A', goal: 'x'.repeat(12_001) }).success).toBe(false);
  });

  it('tells a channel from a thread, and title words from an event link', () => {
    expect(slackKindOf('#checkout')).toBe('channel');
    expect(slackKindOf('https://acme.slack.com/archives/C01ABC/p1763990000000100')).toBe('thread');
    expect(slackKindOf('https://acme.slack.com/archives/D01ABC')).toBe('conversation');
    expect(linkOf('#checkout')).toBeUndefined();
    expect(meetingKindOf('Checkout sync')).toBe('title');
    expect(meetingKindOf('https://calendar.google.com/calendar/event?eid=abc')).toBe('event');
  });
});

describe('doc sources', () => {
  it('works out each doc’s kind from its link', () => {
    const kinds = {
      'https://lendis.atlassian.net/wiki/spaces/IT/pages/2543222788/MDM+-+Part+2': 'confluence',
      'https://lendis.atlassian.net/wiki/spaces/IT/pages/edit-v2/2543222788': 'confluence',
      'https://wiki.acme.com/pages/viewpage.action?pageId=12345': 'confluence',
      'https://github.com/acme/site/pages/123': 'link',
      'https://wiki.acme.com/display/SHOP/Checkout': 'confluence',
      'https://acme.atlassian.net/wiki/x/AbCd': 'link',
      'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit': 'gdoc',
      'https://docs.google.com/document/u/1/d/1AbCdEfGhIjKlMnOp/edit': 'gdoc',
      'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit#gid=0': 'gsheet',
      'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit': 'gslides',
      'https://docs.google.com/forms/d/1AbCdEfGhIjKlMnOp/edit': 'link',
      'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view': 'link',
      'https://docs.example.com/checkout-v2': 'link',
      'not a link': 'link',
    };
    expect(Object.fromEntries(Object.keys(kinds).map((ref) => [ref, docKindOf(ref)]))).toEqual(kinds);
    expect(docKindOf('https://wiki.acme.com/wiki/pages/viewpage.action?pageId=12345')).toBe('confluence');
  });

  it('finds the Confluence page id and the Google file id', () => {
    expect(confluencePageIdOf('https://lendis.atlassian.net/wiki/spaces/IT/pages/2543222788/MDM')).toBe('2543222788');
    expect(confluencePageIdOf('https://wiki.acme.com/wiki/pages/viewpage.action?pageId=12345')).toBe('12345');
    expect(confluencePageIdOf('https://wiki.acme.com/display/SHOP/Checkout')).toBeUndefined();
    expect(googleFileIdOf('https://docs.google.com/spreadsheets/d/1AbC-dEf_GhIjKlMnOp/edit#gid=0')).toBe('1AbC-dEf_GhIjKlMnOp');
    expect(googleFileIdOf('https://evil.example.com/d/1AbCdEfGhIjKlMnOp')).toBeUndefined();
  });

  it('takes {ref, label?, kind?} docs and fills the kind in from the link', () => {
    const config = InitiativeConfigSchema.parse({
      name: 'A',
      docs: [{ ref: ' https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit ', label: ' Spec ' }, { ref: 'https://acme.com/x', kind: 'gdoc' }],
    });
    expect(config.docs).toEqual([
      { ref: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit', label: 'Spec', kind: 'gdoc' },
      { ref: 'https://acme.com/x', kind: 'gdoc' },
    ]);
    expect(InitiativeConfigSchema.safeParse({ name: 'A', docs: [{ ref: 'https://x', kind: 'pdf' }] }).success).toBe(false);
    expect(InitiativeConfigSchema.safeParse({ name: 'A', docs: [{ ref: '' }] }).success).toBe(false);
    expect(InitiativeDraftSchema.parse({ name: 'A', docs: [{ ref: 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit' }] }).docs).toEqual([{ ref: 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit', kind: 'gslides' }]);
  });

  it('migrates an old file’s plain string docs on read, and writes the new shape', () => {
    const old = InitiativeConfigSchema.parse({ name: 'A', docs: ['https://lendis.atlassian.net/wiki/spaces/IT/pages/2543222788/MDM', ' https://docs.example.com/a '] });
    expect(old.docs).toEqual([
      { ref: 'https://lendis.atlassian.net/wiki/spaces/IT/pages/2543222788/MDM', kind: 'confluence' },
      { ref: 'https://docs.example.com/a', kind: 'link' },
    ]);
    expect(InitiativeConfigSchema.parse(JSON.parse(JSON.stringify(old)))).toEqual(old);
  });
});

describe('an epic’s tickets', () => {
  const file = {
    at: '2026-11-24T08:00:00Z',
    tickets: [
      { key: 'SHOP-2', summary: 'Done one', status: 'Done', statusCategory: 'done', epic: 'SHOP-120', updated: '2026-11-20T10:00:00Z', prs: [{ url: 'https://github.com/a/b/pull/7', number: 7, state: 'MERGED', repo: 'a/b' }] },
      { key: 'SHOP-3', summary: 'Open one', status: 'To Do', statusCategory: 'new', assignee: null, epic: 'SHOP-121', updated: '2026-11-22T10:00:00Z' },
      { key: 'SHOP-1', url: 'https://x.atlassian.net/browse/SHOP-1', summary: 'Moving', status: 'In Review', statusCategory: 'In Progress', assignee: 'Ana', epic: 'SHOP-120', updated: '2026-11-23T10:00:00Z', prs: [{ url: 'https://github.com/a/b/pull/9', state: 'draft' }] },
    ],
  };

  it('reads tickets.json as the agent writes it, forgiving how it spells a state', () => {
    const read = TicketsSchema.parse(file);
    expect(read.tickets.map((t) => t.statusCategory)).toEqual(['done', 'todo', 'inProgress']);
    expect(read.tickets[0]!.prs[0]).toMatchObject({ number: 7, state: 'merged', repo: 'a/b' });
    expect(read.tickets[1]).toMatchObject({ prs: [], assignee: undefined });
    expect(read.tickets[2]!.prs[0]).toMatchObject({ state: 'draft' });
    expect(TicketsSchema.safeParse({ tickets: [] }).success).toBe(false);
    expect(TicketsSchema.safeParse({ at: 'now', tickets: [{ summary: 'no key' }] }).success).toBe(false);
  });

  it('sorts open tickets first, and groups by epic when there are several', () => {
    const { tickets } = TicketsSchema.parse(file);
    expect(sortedTickets(tickets).map((t) => t.key)).toEqual(['SHOP-1', 'SHOP-3', 'SHOP-2']);
    expect(ticketGroups(tickets, ['SHOP-120'])).toHaveLength(1);
    expect(ticketGroups(tickets, ['SHOP-120'])[0]!.epic).toBeUndefined();
    expect(ticketGroups(tickets, ['SHOP-120', 'SHOP-121']).map((g) => [g.epic, g.tickets.map((t) => t.key)])).toEqual([
      ['SHOP-120', ['SHOP-1', 'SHOP-2']],
      ['SHOP-121', ['SHOP-3']],
    ]);
    expect(ticketGroups(tickets, ['SHOP-120', 'SHOP-999']).map((g) => g.epic)).toEqual(['SHOP-120', undefined]);
    expect(ticketGroups([], ['SHOP-120'])).toEqual([]);
  });

  it('knows when the epics changed', () => {
    expect(sameKeys(['A-1', 'B-2'], ['B-2', 'A-1'])).toBe(true);
    expect(sameKeys(['A-1'], ['A-1', 'B-2'])).toBe(false);
    expect(sameKeys(['A-1'], ['B-2'])).toBe(false);
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
