import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitFor } from './helpers.js';
import { initiativeChatFound } from '../src/core/initiatives/chat-ref.js';
import { readFolder } from '../src/core/initiatives/files.js';
import { type CheckInHost, Initiatives } from '../src/core/initiatives/initiatives.js';
import { CHECK_IN_CHAT, type InitiativeView, type InitiativesSlice, initiativeChatChannel, initiativeChatTitle, timelineEntryOf } from '../src/core/initiatives/model.js';
import { initiativeBrief } from '../src/core/initiatives/prompt.js';
import { followUpNews } from '../src/core/initiatives/watch-notices.js';
import { watchPrompt } from '../src/core/initiatives/watch-prompt.js';
import { WATCH_CHAT, type Watch, WatchSchema, WatchesSchema, dueWatches, givesUpAt, isDue, needsNudge, nextLookAt, nextWakeAt, unreadNews, watchEvery, watchOfDraft, watchPlaceOf, workingTime } from '../src/core/initiatives/watches.js';
import type { OnceTrigger, SentinelDraft, SentinelPatch } from '../src/core/sentinel/model.js';
import { noticeTarget } from '../src/ui/notice-models.js';
import { Store, initialState } from '../src/core/store.js';

const SELF = 'peer-12345678';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wednesday 25 November 2026, 10:00 local. */
const WED = new Date(2026, 10, 25, 10, 0).getTime();
const iso = (at: number): string => new Date(at).toISOString();
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-watches-'));

const watch = (over: Partial<Watch> & { readonly since: string }): Watch => WatchSchema.parse({ id: 1, what: 'An answer', where: { kind: 'jira', issue: 'SHOP-1' }, ...over });

describe('watches.json', () => {
  it('reads a watch with its defaults, and a folder without the file as none', () => {
    const w = WatchesSchema.parse([{ id: 1, what: 'Julia’s go', where: { kind: 'slack', channel: 'C1', thread: '1.2' }, since: iso(WED), waitingOn: null }]);
    expect(w[0]).toMatchObject({ state: 'watching', news: [], waitingOn: undefined });
    const root = tmp();
    expect(readFolder(root, 'none').watches).toEqual([]);
  });

  it('backs off: hourly the first day, every four hours after, daily after three days', () => {
    expect(watchEvery({}, 0)).toBe(1);
    expect(watchEvery({}, DAY - 1)).toBe(1);
    expect(watchEvery({}, DAY)).toBe(4);
    expect(watchEvery({}, 3 * DAY)).toBe(24);
    expect(watchEvery({ every: 2 }, 5 * DAY)).toBe(2);
    expect(nextLookAt({ since: iso(WED) })).toBe(WED + HOUR);
    expect(nextLookAt({ since: iso(WED), lastLook: iso(WED + 2 * DAY) })).toBe(WED + 2 * DAY + 4 * HOUR);
    expect(nextLookAt({ since: iso(WED), lastLook: iso(WED + 4 * DAY) })).toBe(WED + 5 * DAY);
  });

  it('looks on weekdays during working hours only', () => {
    expect(workingTime(WED)).toBe(WED);
    expect(workingTime(new Date(2026, 10, 25, 22, 0).getTime())).toBe(new Date(2026, 10, 26, 8, 0).getTime());
    expect(workingTime(new Date(2026, 10, 26, 6, 30).getTime())).toBe(new Date(2026, 10, 26, 8, 0).getTime());
    expect(workingTime(new Date(2026, 10, 27, 19, 0).getTime())).toBe(new Date(2026, 10, 30, 8, 0).getTime());
    expect(workingTime(new Date(2026, 10, 29, 12, 0).getTime())).toBe(new Date(2026, 10, 30, 8, 0).getTime());
  });

  it('knows what is due, what needs a nudge and when it gives up', () => {
    const fresh = watch({ since: iso(WED) });
    expect(isDue(fresh, WED + 30 * 60_000)).toBe(false);
    expect(isDue(fresh, WED + HOUR)).toBe(true);
    expect(isDue({ ...fresh, state: 'stopped' }, WED + HOUR)).toBe(false);
    expect(dueWatches([fresh, { ...fresh, id: 2, lastLook: iso(WED + HOUR) }], WED + HOUR)).toHaveLength(1);
    expect(nextWakeAt([fresh, { ...fresh, id: 2, since: iso(WED - DAY) }], WED)).toBe(WED);
    expect(nextWakeAt([{ ...fresh, state: 'answered' }], WED)).toBeUndefined();
    const old = watch({ since: iso(WED - 7 * DAY) });
    expect(needsNudge(old, WED)).toBe(true);
    expect(needsNudge({ ...old, nudgedAt: iso(WED) }, WED)).toBe(false);
    expect(needsNudge({ ...old, news: [{ at: iso(WED), text: 'yes', read: true }] }, WED)).toBe(false);
    expect(givesUpAt(old)).toBe(WED + 7 * DAY);
    expect(givesUpAt({ ...old, until: iso(WED) })).toBe(WED);
  });

  it('reads where to look from what the owner pastes', () => {
    expect(watchPlaceOf('shop-12')).toEqual({ kind: 'jira', issue: 'SHOP-12' });
    expect(watchPlaceOf('https://acme.slack.com/archives/C0CHECK/p1763990000000100', '#checkout')).toEqual({ kind: 'slack', channel: 'C0CHECK', thread: '1763990000.000100', label: '#checkout' });
    expect(watchPlaceOf('https://acme.slack.com/archives/C0CHECK/p1763990000000200?thread_ts=1763990000.000100')).toMatchObject({ thread: '1763990000.000100' });
    expect(watchPlaceOf('https://github.com/acme/shop/pull/412')).toEqual({ kind: 'pr', url: 'https://github.com/acme/shop/pull/412' });
    expect(watchPlaceOf('https://docs.google.com/document/d/abc/edit')).toEqual({ kind: 'doc', ref: 'https://docs.google.com/document/d/abc/edit' });
    expect(watchPlaceOf('  ')).toBeUndefined();
  });

  it('starts a watch from a sent draft, and lists unread news newest first', () => {
    const w = watchOfDraft({ id: 4, to: { kind: 'slack', channel: 'C1', thread: '1.2', label: '#x' }, text: 'Who owns it?', sentText: 'Who owns it, Ana?', suggestion: 2 }, 3, WED);
    expect(w).toMatchObject({ id: 3, draft: 4, suggestion: 2, what: 'An answer to “Who owns it, Ana?”', where: { kind: 'slack', channel: 'C1', thread: '1.2' }, since: iso(WED), state: 'watching' });
    const news = unreadNews([
      { ...w, news: [{ at: iso(WED), text: 'a', read: false }, { at: iso(WED + 1), text: 'b', read: true }] },
      { ...w, id: 4, news: [{ at: iso(WED + 2), text: 'c', read: false }] },
    ]);
    expect(news.map((n) => n.news.text)).toEqual(['c', 'a']);
  });

  it('a follow-up line is its own timeline kind, and the Follow-ups chat has its title', () => {
    expect(timelineEntryOf('2026-11-25 [follow-up]: Ana: signed off')).toEqual({ day: '2026-11-25', kind: 'follow-up', text: 'Ana: signed off' });
    expect(initiativeChatTitle(initiativeChatChannel('a', WATCH_CHAT), [])).toBe('Follow-ups');
  });

  it('the prompt names only the watches given, with a nudge for one that waited a week', () => {
    const prompt = watchPrompt([watch({ since: iso(WED - 8 * DAY), waitingOn: 'Ana', where: { kind: 'jira', issue: 'SHOP-9' } })], WED);
    expect(prompt).toContain('Watch 1: An answer, waiting on Ana');
    expect(prompt).toContain('SHOP-9');
    expect(prompt).toContain('draft a short, friendly nudge into outbox.json');
    expect(prompt).toContain('[follow-up]');
    expect(prompt).toMatch(/change no file and answer with the one word: Nothing/);
  });
});

type Host = CheckInHost & { readonly drafts: SentinelDraft[]; readonly paused: Map<string, boolean>; readonly rewrites: Array<{ readonly id: string; readonly patch: Pick<SentinelPatch, 'trigger' | 'steps'> }> };

const fakeHost = (): Host => {
  const drafts: SentinelDraft[] = [];
  const paused = new Map<string, boolean>();
  const rewrites: Host['rewrites'] = [];
  return {
    drafts,
    paused,
    rewrites,
    create: (draft) => {
      drafts.push(draft);
      const id = `sn${drafts.length}`;
      paused.set(id, true);
      return { id };
    },
    exists: (id) => paused.has(id),
    pause: (id, on) => void paused.set(id, on),
    runNow: () => undefined,
    reschedule: () => undefined,
    remove: (id) => void paused.delete(id),
    rewrite: (id, patch) => void rewrites.push({ id, patch }),
  };
};

const setup = async () => {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true, home: '/Users/k' });
  const root = path.join(tmp(), 'initiatives');
  const host = fakeHost();
  const asked: Array<{ readonly prompt: string; readonly channel: string }> = [];
  let now = WED;
  const service = new Initiatives({
    store,
    root,
    dir: tmp(),
    selfId: () => SELF,
    ask: (prompt, channel) => {
      asked.push({ prompt, channel });
      return `r${asked.length}`;
    },
    checkIns: () => host,
    commit: false,
    now: () => now,
    claudeDir: tmp(),
  });
  await service.start();
  const { slug } = await service.create({ name: 'Checkout' });
  const turnEnds = (chat: string): void => store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'done', text: 'ok', ts: now, channel: initiativeChatChannel(slug, chat) });
  const watches = (): Watch[] => readFolder(root, slug).watches as Watch[];
  return { store, root, host, asked, service, slug, turnEnds, watches, at: (t: number) => (now = t) };
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('Initiatives follow-ups', () => {
  it('sending a draft watches its target, and arms the watch sentinel for its first look', async () => {
    const { root, host, service, slug, watches, turnEnds } = await setup();
    writeFileSync(path.join(root, slug, 'outbox.json'), JSON.stringify([{ id: 1, to: { kind: 'jira', issue: 'SHOP-150' }, text: 'Blocked on Safari.', suggestion: 2 }]));
    service.refresh(slug);
    await service.sendDraft(slug, 1, 'Blocked on Safari.');
    const run = service.chatRun(initiativeChatChannel(slug, 'main'), SELF)!;
    expect(run.vetTool('mcp__jira__jira_add_comment', { issue_key: 'SHOP-150', body: 'Blocked on Safari.' })).toBeUndefined();
    run.onStep({ id: 'send-1', kind: 'tool', title: 'Send', tool: 'mcp__jira__jira_add_comment', status: 'done', startedAt: 1, input: { issue_key: 'SHOP-150', body: 'Blocked on Safari.' }, output: '{"id":"17"}' });
    expect(watches()).toMatchObject([{ id: 1, draft: 1, suggestion: 2, where: { kind: 'jira', issue: 'SHOP-150' }, state: 'watching' }]);
    turnEnds('main');
    await settle();
    const made = host.drafts.find((d) => d.icon === 'eye')!;
    expect(made).toMatchObject({ name: 'Checkout follow-ups', access: 'look', notify: 'off', trigger: { kind: 'once', at: iso(WED + HOUR), missed: 'catch-up' } });
    expect(made.steps![0]).toMatchObject({ kind: 'chat', to: `${SELF}/${initiativeChatChannel(slug, WATCH_CHAT)}` });
    expect(host.paused.get('sn2')).toBe(false);
    expect(service.view(slug).watches).toHaveLength(1);
  });

  it('lists the Follow-ups chat when it arms, so the sentinel finds the chat it wakes', async () => {
    const { store, service, slug } = await setup();
    const channel = initiativeChatChannel(slug, WATCH_CHAT);
    expect(initiativeChatFound(store.getState(), channel)).toBeUndefined();
    await service.addWatch(slug, { what: 'Ana’s go', where: { kind: 'jira', issue: 'SHOP-2' } });
    await waitFor(() => Boolean(initiativeChatFound(store.getState(), channel)));
    expect(service.view(slug).chats.chats.map((c) => c.id)).toContain(WATCH_CHAT);
  });

  it('a sentinel wakes the Check-in and Follow-ups chats in a new session; the others resume theirs', async () => {
    const { service, slug } = await setup();
    for (const chat of [CHECK_IN_CHAT, WATCH_CHAT, 'main']) {
      const channel = initiativeChatChannel(slug, chat);
      service.chatRun(channel, SELF)!.place.onSession(`s-${chat}`);
      expect(service.chatRun(channel, SELF)!.place.resume).toBe(`s-${chat}`);
      expect(service.chatRun(channel, SELF, { woken: true })!.place.resume).toBe(chat === 'main' ? `s-${chat}` : undefined);
    }
  });

  it('merges legacy questions, waits for a confirmed Slack post, and makes one reminder after a successful check', async () => {
    const { root, service, slug, watches, turnEnds, at } = await setup();
    const dir = path.join(root, slug);
    const put = (file: string, value: string): void => writeFileSync(path.join(dir, file), value);
    put('decisions.md', '## Open\n- 2026-11-25: Nobody has asked Finance yet\n- 2026-11-25: Ask Finance about the rollback (waiting on: Daria)\n');
    put('outbox.json', JSON.stringify([{ id: 1, to: { kind: 'slack', channel: 'D123' }, text: 'What does Finance need before rollback?' }]));
    service.refresh(slug);
    const [original, duplicate] = service.view(slug).questions!;
    const question = await service.saveQuestion(slug, { id: original!.id, text: 'What does Finance need before rollback?', merge: duplicate!.id, draft: 1 });
    expect(service.view(slug).questions).toMatchObject([{ id: question.id, waitingOn: 'Daria' }]);
    expect(service.view(slug).waitingQuestions).toBeUndefined();
    expect(service.view(slug).decisions?.open).toEqual([]);
    expect(watches()).toEqual([]);

    const send = async (id: number, message: string, output: string, thread?: string): Promise<void> => {
      const run = service.chatRun(initiativeChatChannel(slug, 'main'), SELF)!;
      const tool = 'mcp__slack__slack_send_message';
      const input = { channel_id: 'D123', message, ...(thread ? { thread_ts: thread } : {}) };
      await service.sendDraft(slug, id, message);
      expect(run.vetTool(tool, input, 'send')).toBeUndefined();
      expect(service.view(slug).outbox.find((draft) => draft.id === id)?.state).toBe('approved');
      run.onStep({ id: 'unapproved-duplicate', kind: 'tool', title: 'Send', tool, status: 'error', startedAt: WED, input, output: 'Denied' });
      expect(service.view(slug).outbox.find((draft) => draft.id === id)?.sendError).toBeUndefined();
      run.onStep({ id: 'send', kind: 'tool', title: 'Send', tool, status: 'done', startedAt: WED, input, output });
      run.finish();
    };
    await send(1, question.text, '{"ok":false,"error":"not_in_channel"}');
    expect(watches()).toEqual([]);
    expect(service.view(slug).outbox[0]).toMatchObject({ state: 'approved', sendError: expect.any(String) });

    const thread = '1795600800.000001';
    await send(1, question.text, JSON.stringify({ ok: true, channel: 'D123', ts: thread }));
    expect(watches()).toMatchObject([{ id: 1, question: question.id, where: { kind: 'slack', channel: 'D123', thread }, waitingOn: 'Daria', state: 'watching' }]);
    expect(service.view(slug).waitingQuestions).toMatchObject([{ text: question.text, waitingOn: 'Daria' }]);
    const due = WED + 7 * DAY;
    at(due);
    turnEnds(WATCH_CHAT);
    expect(readFolder(root, slug).outbox).toHaveLength(1);
    expect(watches()[0]?.checkFailed).toBe(true);

    at(due + HOUR);
    const saveWatch = (patch: Partial<Watch>): void => put('watches.json', JSON.stringify([{ ...watches()[0], ...patch }]));
    saveWatch({ checkedAt: iso(due + HOUR) });
    service.lookNow(slug, 1);
    turnEnds(WATCH_CHAT);
    const reminder = readFolder(root, slug).outbox[1]!;
    expect(reminder).toMatchObject({ state: 'draft', reminderFor: 1, question: question.id, to: { kind: 'slack', thread } });
    await send(reminder.id, reminder.text, JSON.stringify({ ok: true, channel: 'D123', ts: '1796205600.000001' }), thread);
    expect(watches()).toHaveLength(1);

    const partial = { at: iso(due + HOUR), from: 'Daria', text: 'Checking with the team.', read: false };
    saveWatch({ news: [partial], state: 'answered' });
    turnEnds(WATCH_CHAT);
    expect(service.view(slug).questions?.[0]?.answer).toBeUndefined();
    expect(watches()[0]?.state).toBe('watching');
    expect(readFolder(root, slug).outbox).toHaveLength(2);

    const source = 'https://example.slack.com/archives/D123/p1796205600000002';
    saveWatch({ state: 'answered', answer: { text: 'Issue a credit note first.', at: iso(due + HOUR), source } });
    turnEnds(WATCH_CHAT);
    await waitFor(() => service.view(slug).questions?.[0]?.answer?.text === 'Issue a credit note first.');
    expect(service.view(slug).decisions?.decided).toMatchObject([{ text: question.text, why: 'Issue a credit note first.', source }]);
    expect(service.view(slug).waitingQuestions).toBeUndefined();
  });

  it('uses one question ID when the agent asks to track the same ask more than once', async () => {
    const { service, slug, watches } = await setup();
    const run = service.chatRun(initiativeChatChannel(slug, 'main'), SELF)!;
    const first = await run.questions!.track({ text: 'Will this ship Friday?', waitingOn: 'Ana, Daria' });
    const again = await run.questions!.track({ text: 'will this   ship Friday?' });
    expect(again).toEqual(first);
    expect(service.view(slug).questions).toMatchObject([{ id: first.id, waitingOn: 'Ana, Daria' }]);
    expect(service.view(slug).waitingQuestions).toBeUndefined();
    expect(watches()).toHaveLength(0);
    expect(service.chatRun(initiativeChatChannel(slug, WATCH_CHAT), SELF)?.questions).toBeUndefined();
  });

  it('attaches an older sent message to an editable question without duplicating its existing watch', async () => {
    const { root, service, slug, watches } = await setup();
    const link = 'https://example.slack.com/archives/D123/p1763990000000200?thread_ts=1763990000.000100';
    const watch = await service.addWatch(slug, { what: 'Follow the DM', where: { kind: 'slack', channel: 'D123', thread: '1763990000.000100' } });
    const question = await service.saveQuestion(slug, { text: 'Will this ship?', waitingOn: 'Ana', outreach: { ref: link } });
    expect(watches()).toMatchObject([{ id: watch.id, state: 'watching', source: link, question: question.id, since: iso(1763990000000), waitingOn: 'Ana' }]);
    await service.saveQuestion(slug, { id: question.id, text: 'Will this ship?', answer: { text: 'Yes, on Friday.' } });
    expect(watches()).toMatchObject([{ id: watch.id, state: 'answered' }]);
    expect(readFolder(root, slug).questions[0]?.answer?.text).toBe('Yes, on Friday.');
  });

  it('spends no turn while nothing is due, and a quiet look only moves the last look', async () => {
    const { root, host, asked, service, slug, watches, turnEnds, at } = await setup();
    await service.addWatch(slug, { what: 'Julia’s go', where: { kind: 'slack', channel: 'C1', thread: '1.2' }, waitingOn: 'Julia' });
    await service.addWatch(slug, { what: 'Later one', where: { kind: 'jira', issue: 'SHOP-2' }, every: 24 });
    const timeline = readFileSync(path.join(root, slug, 'timeline.md'), 'utf8');
    expect(asked).toEqual([]);
    const last = host.rewrites.at(-1)!;
    expect((last.patch.trigger as OnceTrigger).at).toBe(iso(WED + HOUR));
    const text = (last.patch.steps![0] as { readonly text: string }).text;
    expect(text).toContain('Julia’s go');
    expect(text).not.toContain('Later one');
    at(WED + HOUR + 5 * 60_000);
    turnEnds(WATCH_CHAT);
    await settle();
    expect(watches().map((w) => w.lastLook)).toEqual([iso(WED + HOUR + 5 * 60_000), undefined]);
    expect(readFileSync(path.join(root, slug, 'timeline.md'), 'utf8')).toBe(timeline);
    expect((host.rewrites.at(-1)!.patch.trigger as OnceTrigger).at).toBe(iso(WED + 2 * HOUR + 5 * 60_000));
  });

  it('Look Now, Stop and Mark Read', async () => {
    const { asked, host, service, slug, watches, turnEnds } = await setup();
    const w = await service.addWatch(slug, { what: 'Julia’s go', where: { kind: 'doc', ref: 'https://x/doc' } });
    expect(service.lookNow(slug, w.id)).toEqual({ channel: initiativeChatChannel(slug, WATCH_CHAT) });
    expect(asked.at(-1)!.prompt).toContain('https://x/doc');
    turnEnds(WATCH_CHAT);
    await settle();
    expect(watches()[0]!.lastLook).toBe(iso(WED));
    const withNews = watches().map((x) => ({ ...x, news: [{ at: iso(WED), from: 'Julia', text: 'Go', read: false }] }));
    writeFileSync(path.join(service.view(slug).folder, 'watches.json'), JSON.stringify(withNews));
    await service.readNews(slug);
    expect(watches()[0]!.news[0]!.read).toBe(true);
    await service.stopWatch(slug, w.id);
    expect(watches()[0]!.state).toBe('stopped');
    expect(host.paused.get(host.rewrites.at(-1)!.id)).toBe(true);
    await expect(service.stopWatch(slug, w.id)).rejects.toThrow(/stopped already/);
    expect(() => service.lookNow(slug, 9)).toThrow(/gone/);
  });

  it('gives up after its time, with a follow-up line', async () => {
    const { root, service, slug, watches, turnEnds, at } = await setup();
    await service.addWatch(slug, { what: 'Julia’s go', where: { kind: 'jira', issue: 'SHOP-3' } });
    at(WED + 15 * DAY);
    turnEnds('main');
    await settle();
    expect(watches()[0]!.state).toBe('expired');
    expect(readFileSync(path.join(root, slug, 'timeline.md'), 'utf8')).toContain('[follow-up]: stopped waiting: Julia’s go got no answer');
  });

  it('tells the brief about watches.json, and the Follow-ups chat what it is', async () => {
    const { service, slug } = await setup();
    const item = service.view(slug);
    expect(initiativeBrief(item, '', [], 'main')).toContain('watches.json: follow-ups Beluga keeps looking for');
    expect(initiativeBrief(item, '', [], WATCH_CHAT)).toContain('This is the initiative’s Follow-ups chat');
  });
});

describe('follow-up news', () => {
  const item = (watches: readonly Watch[]): InitiativeView => ({ slug: 'checkout', name: 'Checkout', watches }) as InitiativeView;
  const slice = (items: readonly InitiativeView[]): InitiativesSlice => ({ initiatives: { enabled: true, root: '/r', items } });

  it('raises one notice per new unread item, opening the initiative, and none on the first load', () => {
    const w = watch({ since: iso(WED) });
    const news = { ...w, news: [{ at: iso(WED), from: 'Ana', text: 'Signed off.\nMore', read: false }] };
    const events = followUpNews(slice([item([w])]), slice([item([news])]));
    expect(events).toEqual([{ kind: 'mentions', tag: 'message', title: 'Checkout: Ana answered', body: 'Signed off.', channel: initiativeChatChannel('checkout', WATCH_CHAT), key: `follow-up:checkout:1:${iso(WED)}` }]);
    expect(followUpNews(slice([item([news])]), slice([item([news])]))).toEqual([]);
    expect(followUpNews(slice([]), slice([item([news])]))).toEqual([]);
    expect(followUpNews(slice([item([w])]), slice([item([{ ...news, news: [{ ...news.news[0]!, read: true }] }])]))).toEqual([]);
    expect(noticeTarget({ projects: [], shared: [] }, events[0]!.channel)).toEqual({ kind: 'initiative', slug: 'checkout', chat: WATCH_CHAT });
  });
});
