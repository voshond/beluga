import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChat } from '../src/core/chat-links/resolve.js';
import { type CheckInHost, Initiatives } from '../src/core/initiatives/initiatives.js';
import { CHECK_IN_CHAT, initiativeChatChannel } from '../src/core/initiatives/model.js';
import type { SentinelDraft } from '../src/core/sentinel/model.js';
import { Store, initialState } from '../src/core/store.js';
import { runInstructions } from '../src/agent/run-instructions.js';
import { seedDemoInitiatives } from '../src/core/initiatives/demo.js';
import { waitFor } from './helpers.js';

const SELF = 'peer-12345678';
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-initiatives-'));

type Host = CheckInHost & { readonly drafts: SentinelDraft[]; readonly paused: Map<string, boolean>; readonly ran: string[] };

const fakeHost = (): Host => {
  const drafts: SentinelDraft[] = [];
  const paused = new Map<string, boolean>();
  const ran: string[] = [];
  return {
    drafts,
    paused,
    ran,
    create: (draft) => {
      drafts.push(draft);
      const id = `sn${drafts.length}`;
      paused.set(id, true);
      return { id };
    },
    exists: (id) => paused.has(id),
    pause: (id, on) => void paused.set(id, on),
    runNow: (id) => void ran.push(id),
    remove: (id) => void paused.delete(id),
  };
};

const setup = async (opts: { readonly commit?: boolean; readonly now?: () => number } = {}) => {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true, home: '/Users/k' });
  const root = path.join(tmp(), 'initiatives');
  const host = fakeHost();
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
    checkIns: () => host,
    commit: opts.commit ?? false,
    ...(opts.now ? { now: opts.now } : {}),
    claudeDir: tmp(),
  });
  await service.start();
  return { store, root, host, asked, service };
};

const gitLog = (root: string): string[] => execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim().split('\n');

describe('Initiatives', () => {
  it('makes one: its folder, its chats and its check-in, off', async () => {
    const { store, root, host, service } = await setup();
    const { slug } = await service.create({ name: 'Checkout v2', goal: 'Ship it', epics: ['SHOP-120'], slackChannels: ['#checkout'] });
    expect(slug).toBe('checkout-v2');
    expect(readFileSync(path.join(root, slug, 'initiative.json'), 'utf8')).toContain('"SHOP-120"');
    const item = store.getState().initiatives.items.find((i) => i.slug === slug)!;
    expect(item).toMatchObject({ name: 'Checkout v2', status: 'active', epics: ['SHOP-120'], checkIn: 'sn1' });
    expect(item.chats.chats.map((c) => c.id)).toEqual(['main', CHECK_IN_CHAT]);
    expect(host.drafts[0]).toMatchObject({ trigger: { kind: 'schedule', every: 'week', at: '08:00', days: [1, 2, 3, 4, 5] }, access: 'look' });
    expect(host.drafts[0]!.steps?.[0]).toMatchObject({ kind: 'chat', to: `${SELF}/initiative:checkout-v2:checkin` });
    expect(host.paused.get('sn1')).toBe(true);
    expect((await service.create({ name: 'Checkout v2' })).slug).toBe('checkout-v2-2');
  });

  it('lets a sentinel find its check-in chat by ref', async () => {
    const { store, service } = await setup();
    const { slug } = await service.create({ name: 'Mobile' });
    const chat = resolveChat(store.getState(), { owner: SELF, channel: initiativeChatChannel(slug, CHECK_IN_CHAT) });
    expect(chat).toMatchObject({ kind: 'initiative', state: 'idle', title: 'Mobile: Check-in', view: { kind: 'initiative_page', slug, chat: CHECK_IN_CHAT } });
  });

  it('turns its check-in on and off, and checks in now', async () => {
    const { host, service } = await setup();
    const { slug } = await service.create({ name: 'A' });
    service.setCheckIn(slug, true);
    expect(host.paused.get('sn1')).toBe(false);
    service.setCheckIn(slug, false);
    expect(host.paused.get('sn1')).toBe(true);
    expect(service.checkInNow(slug)).toEqual({ channel: initiativeChatChannel(slug, CHECK_IN_CHAT) });
    expect(host.ran).toEqual(['sn1']);
  });

  it('keeps many chats: new, open, delete, and the check-in chat stays', async () => {
    const { store, service } = await setup();
    const { slug } = await service.create({ name: 'A' });
    const made = service.chatNew(slug);
    const item = (): ReturnType<typeof store.getState>['initiatives']['items'][number] => store.getState().initiatives.items[0]!;
    expect(item().chats.active).toBe(made.id);
    service.chatOpen(slug, 'main');
    expect(item().chats.active).toBe('main');
    await service.chatDelete(slug, made.id);
    expect(item().chats.chats.map((c) => c.id)).toEqual(['main', CHECK_IN_CHAT]);
    await expect(service.chatDelete(slug, CHECK_IN_CHAT)).rejects.toThrow(/Check-in chat stays/);
    expect(() => service.chatOpen(slug, made.id)).toThrow(/deleted/);
  });

  it('runs a chat in the initiative’s folder, for you only, with the brief', async () => {
    const { root, service } = await setup();
    const { slug } = await service.create({ name: 'Checkout v2', goal: 'Ship it', epics: ['SHOP-120'], repos: ['shop-web'] });
    writeFileSync(path.join(root, slug, 'brief.md'), '# Checkout v2\n\nTwo blockers left.\n');
    const channel = initiativeChatChannel(slug, 'main');
    const run = service.chatRun(channel, SELF)!;
    expect(run.place).toMatchObject({ cwd: path.join(root, slug), autoEdit: true, additionalDirectories: [] });
    expect(run.brief).toContain('Initiative: Checkout v2 (active)');
    expect(run.brief).toContain('Jira epics: SHOP-120');
    expect(run.brief).toContain('Two blockers left.');
    expect(run.brief).toContain('- shop-web');
    expect(run.brief).toContain('Suggest, never act outward on your own');
    expect(run.brief).not.toContain('Check-in chat');
    expect(service.chatRun(initiativeChatChannel(slug, CHECK_IN_CHAT), SELF)!.brief).toContain('Check-in chat');
    expect(service.chatRun(channel, 'someone-else-123')).toBeUndefined();
    expect(service.chatRun(initiativeChatChannel('nope', 'main'), SELF)).toBeUndefined();
    expect(runInstructions({ prompt: 'x', initiativeBrief: run.brief } as Parameters<typeof runInstructions>[0], 'kay')).toContain('Two blockers left.');
  });

  it('approves a suggestion into the chat, and dismisses another', async () => {
    const { root, asked, store, service } = await setup();
    const { slug } = await service.create({ name: 'A' });
    writeFileSync(path.join(root, slug, 'suggestions.json'), JSON.stringify([{ id: 1, text: 'Comment on SHOP-150' }, { id: 2, text: 'Move the go/no-go' }]));
    service.refresh(slug);
    expect(store.getState().initiatives.items[0]!.suggestions.map((s) => s.state)).toEqual(['open', 'open']);
    expect(await service.resolveSuggestion(slug, 1, 'approve')).toEqual({ channel: initiativeChatChannel(slug, 'main') });
    expect(asked).toEqual([{ prompt: 'Do suggestion 1: Comment on SHOP-150', channel: initiativeChatChannel(slug, 'main') }]);
    expect(await service.resolveSuggestion(slug, 2, 'dismiss')).toEqual({});
    expect(asked).toHaveLength(1);
    const saved = JSON.parse(readFileSync(path.join(root, slug, 'suggestions.json'), 'utf8')) as Array<{ state: string; resolvedAt?: string }>;
    expect(saved.map((s) => s.state)).toEqual(['approved', 'dismissed']);
    expect(saved.every((s) => Boolean(s.resolvedAt))).toBe(true);
    await expect(service.resolveSuggestion(slug, 1, 'approve')).rejects.toThrow(/already approved/);
  });

  it('shows a bad initiative.json as trouble and keeps the rest going', async () => {
    const { root, store, service } = await setup();
    const { slug } = await service.create({ name: 'Broken' });
    await service.create({ name: 'Fine' });
    writeFileSync(path.join(root, slug, 'initiative.json'), '{ nope');
    service.refresh(slug);
    const broken = store.getState().initiatives.items.find((i) => i.slug === slug)!;
    expect(broken.name).toBe(slug);
    expect(broken.trouble).toMatch(/not valid JSON/);
    expect(store.getState().initiatives.items).toHaveLength(2);
    await expect(service.update(slug, { goal: 'x' })).rejects.toThrow(/Fix broken\/initiative\.json first/);
  });

  it('commits the folder when made, changed, and after a chat turn that changed it', async () => {
    const { root, store, service } = await setup({ commit: true });
    const { slug } = await service.create({ name: 'Tracked' });
    expect(gitLog(root)).toEqual(['tracked: created', 'Initiatives']);
    await service.update(slug, { goal: 'Ship it' });
    expect(gitLog(root)[0]).toBe('tracked: updated');
    writeFileSync(path.join(root, slug, 'timeline.md'), '# Timeline\n\n- today: checked\n');
    store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'done', text: 'ok', ts: Date.now(), channel: initiativeChatChannel(slug, CHECK_IN_CHAT) });
    await waitFor(() => store.getState().initiatives.items[0]!.recent[0] === 'today: checked');
    expect(gitLog(root)[0]).toMatch(/^tracked: check-in \d{4}-\d{2}-\d{2}$/);
  });

  it('seeds the demo’s two initiatives', async () => {
    const { root, store, service } = await setup();
    await seedDemoInitiatives(service, root, Date.parse('2026-11-24T10:00:00Z'));
    const items = store.getState().initiatives.items;
    expect(items.map((i) => i.name)).toEqual(['Checkout v2', 'Mobile Onboarding']);
    expect(items[0]).toMatchObject({ progress: { total: 34, done: 21 }, openDecisions: [expect.stringContaining('Norway'), expect.stringContaining('guest checkout')] });
    expect(items.every((i) => i.suggestions.length > 0 && !i.trouble)).toBe(true);
  });

  it('shows a failing backup push until one goes through', async () => {
    let at = 1_000;
    const { store, root, service } = await setup({ commit: true, now: () => at });
    const remote = path.join(tmp(), 'remote.git');
    execFileSync('git', ['init', '--quiet', '--bare', remote]);
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    execFileSync('git', ['push', '--quiet', '-u', 'origin', 'HEAD'], { cwd: root });
    execFileSync('git', ['remote', 'set-url', 'origin', path.join(tmp(), 'missing.git')], { cwd: root });
    const { slug } = await service.create({ name: 'Checkout v2', goal: 'Ship it' });
    const first = store.getState().initiatives.backup;
    expect(first).toMatchObject({ since: 1_000 });
    expect(first?.error).toBeTruthy();
    at = 5_000;
    await service.update(slug, { goal: 'Ship it soon' });
    expect(store.getState().initiatives.backup?.since).toBe(1_000);
    execFileSync('git', ['remote', 'set-url', 'origin', remote], { cwd: root });
    await service.update(slug, { goal: 'Ship it now' });
    expect(store.getState().initiatives.backup).toBeUndefined();
    expect(gitLog(remote)[0]).toBe(`${slug}: updated`);
  });
});
