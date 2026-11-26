import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AudienceSchema } from '../src/core/initiatives/audience.js';
import { Initiatives, OUTBOX_DENIED } from '../src/core/initiatives/initiatives.js';
import { CHECK_IN_CHAT, InitiativeConfigSchema, type InitiativeView, OutboxDraftSchema, type Ticket, TicketSchema, initiativeChatChannel, matchesDraft, sendDraftMessage, timelineEntryOf } from '../src/core/initiatives/model.js';
import { CHECK_IN_PROMPT } from '../src/core/initiatives/prompt.js';
import { UPDATES_CHECK_IN, audiencesBrief, draftUpdatePrompt } from '../src/core/initiatives/updates-prompt.js';
import { deltaLines, isUpdateDue, lastSlot, nextDueOf, nextSlot, openWithWhom, slackTargetOf, ticketDelta, ticketMarks } from '../src/core/initiatives/updates.js';
import { Store, initialState } from '../src/core/store.js';

const SELF = 'peer-12345678';
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-updates-'));

/** Thursday 26 November 2026, noon, local time. */
const NOW = new Date(2026, 10, 26, 12, 0).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ticket = (key: string, status: string, statusCategory: string, assignee?: string): Ticket => TicketSchema.parse({ key, summary: `${key} work`, status, statusCategory, ...(assignee ? { assignee } : {}) });

const setup = async () => {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true, home: '/Users/k' });
  const root = path.join(tmp(), 'initiatives');
  const asked: Array<{ readonly prompt: string; readonly channel: string }> = [];
  const service = new Initiatives({
    store,
    root,
    dir: tmp(),
    selfId: () => SELF,
    ask: (prompt, channel) => {
      asked.push({ prompt, channel });
      return `r${asked.length}`;
    },
    now: () => NOW,
    claudeDir: tmp(),
  });
  await service.start();
  const { slug } = await service.create({ name: 'Checkout', meetings: [{ match: 'Go/no-go' }] });
  const { slug: kai } = await service.savePerson({ name: 'Kai Jensen', slack: '@kai' });
  const item = (): InitiativeView => store.getState().initiatives.items.find((i) => i.slug === slug)!;
  return { store, root, asked, service, slug, kai, item };
};

describe('audiences in initiative.json', () => {
  it('loads a live initiative without audiences as none, and fills an audience’s defaults', () => {
    expect(InitiativeConfigSchema.parse({ name: 'e-Invoicing', epics: ['EI-1'] }).audiences).toEqual([]);
    expect(AudienceSchema.parse({ id: 'execs', name: 'Execs', target: { kind: 'slack', channel: 'C1' } })).toEqual({ id: 'execs', name: 'Execs', people: [], tone: 'detailed', cadence: { days: [], at: '09:00' }, target: { kind: 'slack', channel: 'C1' } });
    expect(() => AudienceSchema.parse({ id: 'x', name: 'X', target: { kind: 'confluence', page: 'not-a-page', section: 'Status' } })).toThrow();
  });

  it('reads a Slack link as its channel and thread', () => {
    expect(slackTargetOf('https://acme.slack.com/archives/C0CHECKOUT/p1763990000000100', 'Safari')).toEqual({ kind: 'slack', channel: 'C0CHECKOUT', thread: '1763990000.000100', label: 'Safari' });
    expect(slackTargetOf(' #leadership ')).toEqual({ kind: 'slack', channel: '#leadership' });
  });

  it('keeps 5000 characters for Slack but room for a page, and knows the update kind on the timeline', () => {
    const long = 'x'.repeat(9000);
    expect(OutboxDraftSchema.parse({ id: 1, to: { kind: 'confluence', page: '22', section: 'Status' }, text: long, audience: 'team' }).audience).toBe('team');
    expect(timelineEntryOf('2026-11-26 [update]: sent the Leadership update').kind).toBe('update');
  });
});

describe('cadence', () => {
  const thursday9 = { days: [4], at: '09:00' };

  it('finds the next and the last slot in local time', () => {
    expect(new Date(NOW).getDay()).toBe(4);
    expect(nextSlot(thursday9, NOW)).toBe(new Date(2026, 11, 3, 9, 0).getTime());
    expect(lastSlot(thursday9, NOW)).toBe(new Date(2026, 10, 26, 9, 0).getTime());
    expect(nextSlot({ days: [], at: '09:00' }, NOW)).toBeUndefined();
  });

  it('is due at the latest slot when never sent, then the first slot after the last update, and not while a draft waits', () => {
    const audience = { id: 'team', cadence: thursday9 };
    const none = { updates: [], outbox: [] };
    expect(nextDueOf(none, audience, NOW)).toBe(new Date(2026, 10, 26, 9, 0).getTime());
    expect(isUpdateDue(none, audience, NOW)).toBe(true);
    const sent = { updates: [{ audience: 'team', at: new Date(NOW - 7 * DAY).toISOString(), draft: 1, to: { kind: 'prep' as const, meeting: 'x' }, file: 'updates/a.md', tickets: [] }], outbox: [] };
    expect(isUpdateDue(sent, audience, NOW)).toBe(true);
    expect(isUpdateDue({ ...sent, updates: [{ ...sent.updates[0]!, at: new Date(NOW - HOUR).toISOString() }] }, audience, NOW)).toBe(false);
    const waiting = OutboxDraftSchema.parse({ id: 2, to: { kind: 'slack', channel: 'C1' }, text: 'hi', audience: 'team' });
    expect(isUpdateDue({ ...sent, outbox: [waiting] }, audience, NOW)).toBe(false);
    expect(isUpdateDue(none, { id: 'team', cadence: { days: [], at: '09:00' } }, NOW)).toBe(false);
  });
});

describe('what changed', () => {
  it('works out the ticket delta against the last update’s snapshot', () => {
    const before = ticketMarks([ticket('A-1', 'In Progress', 'inProgress', 'Ana'), ticket('A-2', 'To Do', 'todo'), ticket('A-3', 'To Do', 'todo')]);
    const after = [ticket('A-1', 'Done', 'done', 'Ana'), ticket('A-2', 'In Review', 'inProgress', 'Kai'), ticket('A-4', 'To Do', 'todo')];
    const delta = ticketDelta(before, after);
    expect(delta.done.map((t) => t.key)).toEqual(['A-1']);
    expect(delta.moved.map((m) => [m.ticket.key, m.from])).toEqual([['A-2', 'To Do']]);
    expect(delta.added.map((t) => t.key)).toEqual(['A-4']);
    expect(delta.reassigned.map((r) => [r.ticket.key, r.from])).toEqual([['A-2', undefined]]);
    expect(deltaLines(delta)).toEqual(['done: A-1 A-1 work', 'moved: A-2 A-2 work (To Do → In Review)', 'new: A-4 A-4 work (To Do)', 'reassigned: A-2 (nobody → Kai)', 'no longer under the epics: A-3 A-3 work']);
  });

  it('says what is open and with whom, by the directory’s names', () => {
    const people = [{ slug: 'kai-jensen', name: 'Kai Jensen', cares: '', slack: '@kai', jira: '', notes: '' }];
    const item = { suggestions: [{ id: 1, text: 'Norway table', kind: 'other' as const, state: 'open' as const, waitingOn: '@kai' }, { id: 2, text: 'Done one', kind: 'other' as const, state: 'approved' as const, waitingOn: 'kai-jensen' }], waitingQuestions: [{ text: 'Who owns lists?', waitingOn: 'Ana' }] };
    expect(openWithWhom(item, people)).toEqual(['waiting on Kai Jensen: Norway table', 'waiting on Ana: Who owns lists?']);
  });
});

describe('the outbox learns Confluence and prep sheets', () => {
  it('matches a Confluence section update exactly, and tells the chat the call', () => {
    const to = { kind: 'confluence' as const, page: '2201', section: 'Status' };
    const input = { page_id: '2201', heading_text: 'Status', new_content: 'All good.' };
    expect(matchesDraft(to, 'All good.', 'mcp__jira__confluence_update_page_section', input)).toBe(true);
    expect(matchesDraft(to, 'All good.', 'mcp__jira__confluence_update_page_section', { ...input, heading_text: 'status' })).toBe(false);
    expect(matchesDraft(to, 'All good.', 'mcp__jira__confluence_update_page_section', { ...input, content_format: 'storage' })).toBe(false);
    expect(matchesDraft({ kind: 'prep', meeting: 'x' }, 'All good.', 'mcp__jira__confluence_update_page_section', input)).toBe(false);
    expect(sendDraftMessage({ id: 3, to }, 'All good.')).toContain('confluence_update_page_section with page_id 2201, heading_text exactly "Status"');
  });
});

describe('stakeholder updates', () => {
  it('saves audiences with their people, refusing strangers and meetings it does not follow', async () => {
    const { service, slug, kai, item } = await setup();
    expect(await service.saveAudience(slug, { name: 'Leadership', people: [kai], tone: 'short', cadence: { days: [5], at: '16:00' }, target: { kind: 'slack', channel: 'C0LEAD' } })).toEqual({ id: 'leadership' });
    expect(await service.saveAudience(slug, { name: 'Leadership', target: { kind: 'prep', meeting: 'Go/no-go' } })).toEqual({ id: 'leadership-2' });
    await expect(service.saveAudience(slug, { name: 'X', people: ['nobody'], target: { kind: 'slack', channel: 'C1' } })).rejects.toThrow('not in the people directory');
    await expect(service.saveAudience(slug, { name: 'X', target: { kind: 'prep', meeting: 'Standup' } })).rejects.toThrow('Follow that meeting first');
    await service.saveAudience(slug, { id: 'leadership', name: 'Execs', people: [kai], tone: 'short', target: { kind: 'slack', channel: 'C0LEAD' } });
    expect(item().audiences!.map((a) => [a.id, a.name])).toEqual([['leadership', 'Execs'], ['leadership-2', 'Leadership']]);
    await service.removeAudience(slug, 'leadership-2');
    expect(item().audiences!.map((a) => a.id)).toEqual(['leadership']);
  });

  it('marks due audiences in the Check-in chat’s brief with the facts, and Draft Now asks the Check-in chat', async () => {
    const { root, asked, service, slug, kai, item } = await setup();
    await service.saveAudience(slug, { name: 'Leadership', people: [kai], tone: 'short', cadence: { days: [4], at: '09:00' }, target: { kind: 'slack', channel: 'C0LEAD' } });
    await service.saveAudience(slug, { name: 'Team', tone: 'detailed', target: { kind: 'confluence', page: '2201', section: 'Status' } });
    writeFileSync(path.join(root, slug, 'suggestions.json'), JSON.stringify([{ id: 1, text: 'Launch Norway?', kind: 'decision', options: ['Yes', 'No'], state: 'approved', answer: 'Yes', resolvedAt: new Date(NOW - HOUR).toISOString() }]));
    service.refresh(slug);
    expect(CHECK_IN_PROMPT).toContain(UPDATES_CHECK_IN);
    const brief = service.chatRun(initiativeChatChannel(slug, CHECK_IN_CHAT), SELF)!.brief;
    expect(brief).toContain('- Leadership (id leadership): Kai Jensen; tone short; Thu at 09:00; to Slack: C0LEAD; last sent never; DUE: draft its update in this check-in');
    expect(brief).toContain('- Team (id team): nobody named; tone detailed; on request only;');
    expect(brief).toContain('Facts for Leadership (leadership):');
    expect(brief).toContain('Launch Norway? → Yes');
    expect(brief).not.toContain('Facts for Team');
    expect(service.draftUpdate(slug, 'team')).toEqual({ channel: initiativeChatChannel(slug, CHECK_IN_CHAT) });
    expect(asked.at(-1)!.prompt).toContain('Draft the stakeholder update for the audience “Team” (id team) now, and nothing else.');
    expect(asked.at(-1)!.prompt).toContain('Ticket delta: none to compare with yet');
    expect(() => service.draftUpdate(slug, 'gone')).toThrow('That audience is gone');
    expect(audiencesBrief({ ...item(), audiences: [] }, [], NOW)).toBe('');
  });

  it('keeps a sent update with its ticket snapshot, logs it as an update, and the next delta starts there', async () => {
    const { root, store, service, slug, item } = await setup();
    await service.saveAudience(slug, { name: 'Team', cadence: { days: [4], at: '09:00' }, target: { kind: 'confluence', page: '2201', section: 'Status' } });
    writeFileSync(path.join(root, slug, 'tickets.json'), JSON.stringify({ at: new Date(NOW).toISOString(), tickets: [{ key: 'A-1', status: 'To Do', statusCategory: 'todo' }] }));
    writeFileSync(path.join(root, slug, 'outbox.json'), JSON.stringify([{ id: 1, to: { kind: 'confluence', page: '2201', section: 'Status' }, audience: 'team', text: 'Draft text' }]));
    service.refresh(slug);
    expect(isUpdateDue(item(), item().audiences![0]!, NOW)).toBe(false);
    const run = service.chatRun(initiativeChatChannel(slug, 'main'), SELF)!;
    const call = { page_id: '2201', heading_text: 'Status', new_content: 'Edited text' };
    expect(run.vetTool('mcp__jira__confluence_update_page_section', call)).toBe(OUTBOX_DENIED);
    await service.sendDraft(slug, 1, 'Edited text');
    expect(run.vetTool('mcp__jira__confluence_update_page_section', { ...call, new_content: 'Draft text' })).toBe(OUTBOX_DENIED);
    expect(run.vetTool('mcp__jira__confluence_update_page_section', call)).toBeUndefined();
    expect(run.preApproved('mcp__jira__confluence_update_page_section', call)).toBe(true);
    run.onStep({ id: 'send-1', kind: 'tool', title: 'Send', tool: 'mcp__jira__confluence_update_page_section', status: 'done', startedAt: 1, input: call, output: '{"id":"2201"}' });
    const sent = store.getState().initiatives.items[0]!;
    expect(sent.outbox[0]).toMatchObject({ state: 'sent', sentText: 'Edited text', text: 'Draft text' });
    expect(sent.updates).toEqual([{ audience: 'team', at: new Date(NOW).toISOString(), draft: 1, to: { kind: 'confluence', page: '2201', section: 'Status' }, file: 'updates/2026-11-26-team-1.md', tickets: [{ key: 'A-1', summary: '', status: 'To Do', done: false }] }]);
    expect(readFileSync(path.join(root, slug, 'updates/2026-11-26-team-1.md'), 'utf8')).toContain('Edited text');
    expect(sent.timeline[0]).toMatchObject({ kind: 'update', text: 'sent the Team update to Confluence page 2201 › Status' });
    expect(sent.files).toContain('updates.json');
    expect(sent.watches ?? []).toEqual([]);
    writeFileSync(path.join(root, slug, 'tickets.json'), JSON.stringify({ at: new Date(NOW).toISOString(), tickets: [{ key: 'A-1', status: 'Done', statusCategory: 'done' }] }));
    service.refresh(slug);
    expect(draftUpdatePrompt(item(), item().audiences![0]!, [])).toContain('done: A-1');
  });

  it('never sends a prep sheet: Done keeps it with the edits, and a long Slack update is refused', async () => {
    const { root, asked, service, slug, item } = await setup();
    await service.saveAudience(slug, { name: 'Go/no-go', target: { kind: 'prep', meeting: 'Go/no-go' } });
    writeFileSync(
      path.join(root, slug, 'outbox.json'),
      JSON.stringify([
        { id: 1, to: { kind: 'prep', meeting: 'Go/no-go' }, audience: 'go-no-go', text: '## Raise\n\n- Norway' },
        { id: 2, to: { kind: 'slack', channel: 'C1' }, text: 'x'.repeat(6000) },
      ]),
    );
    service.refresh(slug);
    await expect(service.sendDraft(slug, 1, 'anything')).rejects.toThrow('A prep sheet is never sent');
    await expect(service.sendDraft(slug, 2, 'x'.repeat(6000))).rejects.toThrow('takes 5000 at most');
    await expect(service.keepPrep(slug, 2, 'x')).rejects.toThrow('Only a prep sheet');
    await service.keepPrep(slug, 1, '## Raise\n\n- Norway\n- Safari');
    expect(asked).toEqual([]);
    expect(item().outbox[0]).toMatchObject({ state: 'sent', sentText: '## Raise\n\n- Norway\n- Safari' });
    expect(item().updates![0]).toMatchObject({ audience: 'go-no-go', draft: 1, file: 'updates/2026-11-26-go-no-go-1.md' });
    expect(item().timeline[0]).toMatchObject({ kind: 'update', text: 'prep sheet for Go/no-go ready for Go/no-go' });
  });
});
