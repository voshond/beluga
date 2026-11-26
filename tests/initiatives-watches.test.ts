import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFolder } from '../src/core/initiatives/files.js';
import { type CheckInHost, Initiatives } from '../src/core/initiatives/initiatives.js';
import { type InitiativeView, type InitiativesSlice, initiativeChatChannel, initiativeChatTitle, timelineEntryOf } from '../src/core/initiatives/model.js';
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
    expect(watches()).toMatchObject([{ id: 1, draft: 1, suggestion: 2, where: { kind: 'jira', issue: 'SHOP-150' }, state: 'watching' }]);
    turnEnds('main');
    await settle();
    const made = host.drafts.find((d) => d.icon === 'eye')!;
    expect(made).toMatchObject({ name: 'Checkout follow-ups', access: 'look', notify: 'off', trigger: { kind: 'once', at: iso(WED + HOUR), missed: 'catch-up' } });
    expect(made.steps![0]).toMatchObject({ kind: 'chat', to: `${SELF}/${initiativeChatChannel(slug, WATCH_CHAT)}` });
    expect(host.paused.get('sn2')).toBe(false);
    expect(service.view(slug).watches).toHaveLength(1);
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
