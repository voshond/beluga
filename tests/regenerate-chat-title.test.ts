import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sideCalls } from '../src/agent/side-calls.js';
import type { CompletionRequest } from '../src/agent/runtime/types.js';
import { createMockBackend } from '../src/agent/mock.js';
import type { Conversation } from '../src/agent/transcript.js';
import { conversations } from '../src/companion/views.js';
import { Session, type SessionOptions } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { type LogItem, Store, initialState } from '../src/core/store.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { PeerClient } from '../src/net/peer-client.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { attach } from './helpers.js';

const SESSION = 'saved-session';
const TRANSCRIPT_TEXT = 'Plan the database migration';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' });
const transcript = (sessionId = SESSION): Conversation => ({
  sessionId,
  title: 'Old conversation',
  lastModified: 1,
  // An id that isImportedItem accepts, as transcriptToTurns gives.
  items: [{ id: 't-1', type: 'chat', channel: '', from: 'me', name: 'kay', byAgent: false, text: TRANSCRIPT_TEXT, ts: 1 }],
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(opts: { findConversation?: SessionOptions['findConversation'] } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-regenerate-title-'));
  const files = new WorkspaceStore(home);
  files.saveConfig({ roots: [], projects: [], hidden: [] });
  const manager = new WorkspaceManager(files);
  const store = new Store(initialState('demo'));
  const titleChat = vi.fn(async (_content: string) => 'Database migration plan');
  const run = vi.fn();
  const session = new Session({
    client: new PeerClient({ url: 'ws://127.0.0.1:1', keys: deriveKeys(generateSecret()), profile: { name: 'kay', shares: [], agent: true } }),
    store,
    shares: new ShareService([]),
    workspaces: manager,
    agentCwd: home,
    createAgent: (bridge) => ({ ...createMockBackend(bridge, 0), titleChat, run }),
    ...(opts.findConversation ? { findConversation: opts.findConversation } : {}),
  });
  const client = attach(session);
  cleanups.push(async () => {
    client.close();
    await session.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const controller = session.workspaces!;
  await controller.refresh();
  const chat = (await controller.newChat('chats', 'First topic', undefined, { quiet: true }))!;
  manager.rememberSession(chat.id, 'keep-this-session');
  controller.ensureLoaded(chat.id);
  const channel = `ws:${chat.id}`;
  store.dispatch({ type: 'chat', id: 'first', from: 'me', byAgent: false, text: 'First topic: CSS colors', channel, ts: 1 });
  store.dispatch({ type: 'chat', id: 'recent', from: 'me', byAgent: false, text: 'Now plan the database migration', channel, ts: 2 });
  store.dispatch({ type: 'agent_event', owner: 'me', requester: 'me', requestId: 'answer', event: 'done', text: 'Use a staged schema migration', channel, ts: 3 });
  return { home, store, manager, session, client, controller, chat, channel, titleChat, run };
}

/** A real chat in a project's main folder with nothing saved, as main-migration.ts leaves one. */
async function projectChat({ home, manager, controller }: Awaited<ReturnType<typeof setup>>, sessionId?: string) {
  const root = path.join(home, 'code', 'app');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), '1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  const projectId = manager.addProject(root);
  await controller.refresh();
  const chat = (await controller.newChat(projectId, 'Session chat', undefined, { quiet: true }))!;
  if (sessionId) manager.rememberSession(chat.id, sessionId);
  return { chat, channel: `ws:${chat.id}` };
}

const logIds = (store: Store, channel: string) => store.getState().log.filter((l) => l.channel === channel).map((l) => l.id);

it('regenerates from recent chat content without changing messages or the agent session', async () => {
  const { store, manager, client, controller, chat, channel, titleChat, run } = await setup();
  const before = store.getState().log;

  expect(await client.api.workspaces.regenerateTitle(chat.id)).toEqual({ name: 'Database migration plan' });

  expect(titleChat).toHaveBeenCalledWith(expect.stringContaining('Now plan the database migration'));
  expect(titleChat.mock.calls[0]?.[0]).toContain('Use a staged schema migration');
  expect(store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.id === chat.id)?.name).toBe('Database migration plan');
  expect(conversations(store.getState())).toContainEqual(expect.objectContaining({ channel, title: 'Database migration plan' }));
  expect(store.getState().log).toEqual(before);
  expect(manager.find(chat.id)?.sessionId).toBe('keep-this-session');
  expect(run).not.toHaveBeenCalled();
  await controller.renameChat(chat.id, 'Automatic title');
  expect(manager.find(chat.id)?.name).toBe('Database migration plan');
  await client.api.workspaces.rename(chat.id, 'My manual title');
  await controller.renameChat(chat.id, 'Another automatic title');
  expect(manager.find(chat.id)?.name).toBe('My manual title');
});

it('names the current topic with a bounded one-turn side call', async () => {
  const requests: CompletionRequest[] = [];
  const calls = sideCalls(async (req) => {
    requests.push(req);
    return '"Database migration plan."';
  }, '/demo');
  const content = 'Old CSS topic. '.repeat(2000) + 'Now plan the database migration';

  expect(await calls.titleChat(content)).toBe('Database migration plan');

  expect(requests).toHaveLength(1);
  expect(requests[0]?.prompt).toContain('Now plan the database migration');
  expect(requests[0]?.prompt.length).toBeLessThan(12_200);
  expect(requests[0]).toMatchObject({ cwd: '/demo', model: 'haiku' });
  expect(requests[0]?.tools).toBeUndefined();
  expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
});

it.each(['', '---', 'This response contains far too many words to be a usable short chat title'])('keeps the old title and reports an unusable result: %s', async (result) => {
  const { store, manager, client, chat, titleChat } = await setup();
  titleChat.mockResolvedValue(result);
  const before = store.getState().log;

  await expect(client.api.workspaces.regenerateTitle(chat.id)).rejects.toThrow('Cannot generate a usable chat title');

  expect(manager.find(chat.id)?.name).toBe('First topic');
  expect(store.getState().log).toEqual(before);
  expect(client.store.getState().toast).toMatchObject({ level: 'error' });
});

it('keeps the old title when generation fails', async () => {
  const { manager, client, chat, titleChat } = await setup();
  titleChat.mockRejectedValue(new Error('Generation failed'));
  await expect(client.api.workspaces.regenerateTitle(chat.id)).rejects.toThrow('Cannot generate a usable chat title');
  expect(manager.find(chat.id)?.name).toBe('First topic');
});

it('uses only a bounded recent part of this chat', async () => {
  const { store, client, chat, channel, titleChat } = await setup();
  store.dispatch({ type: 'chat', id: 'large', from: 'me', byAgent: false, text: 'Old content '.repeat(2000), channel, ts: 4 });
  store.dispatch({ type: 'chat', id: 'latest', from: 'me', byAgent: false, text: 'Latest topic: database migration', channel, ts: 5 });
  store.dispatch({ type: 'system', channel, text: 'Private tool output' });
  store.dispatch({ type: 'chat', id: 'other', from: 'me', byAgent: false, text: 'Another chat', channel: 'ws:other', ts: 6 });

  await client.api.workspaces.regenerateTitle(chat.id);

  const content = titleChat.mock.calls[0]![0];
  expect(content.length).toBeLessThanOrEqual(12_000);
  expect(content).toContain('Latest topic: database migration');
  expect(content).not.toContain('First topic: CSS colors');
  expect(content).not.toContain('Private tool output');
  expect(content).not.toContain('Another chat');
});

it('loads saved messages when the chat is not open', async () => {
  const { manager, client, controller, titleChat } = await setup();
  const saved = (await controller.newChat('chats', 'Saved chat', undefined, { quiet: true }))!;
  manager.saveHistory(saved.id, [{ id: 'saved', type: 'chat', channel: `ws:${saved.id}`, from: 'me', name: 'kay', byAgent: false, text: 'Current saved topic', ts: 1 }]);
  await client.api.workspaces.regenerateTitle(saved.id);
  expect(titleChat).toHaveBeenCalledWith('User: Current saved topic');
});

it('rejects empty chats and missing workspaces without a side call', async () => {
  const { client, controller, titleChat } = await setup();
  const empty = (await controller.newChat('chats', 'Empty', undefined, { quiet: true }))!;
  await expect(client.api.workspaces.regenerateTitle(empty.id)).rejects.toThrow('no content');
  await expect(client.api.workspaces.regenerateTitle('missing')).rejects.toThrow('Select a chat');
  expect(titleChat).not.toHaveBeenCalled();
});

it('handles side-call errors and unusable output without a real LLM', async () => {
  const failed = sideCalls(async () => { throw new Error('Model unavailable'); }, '/demo');
  expect(await failed.titleChat('User: current topic')).toBeUndefined();
  const unusable = sideCalls(async () => '---', '/demo');
  expect(await unusable.titleChat('User: current topic')).toBeUndefined();
});

it('reads the transcript of a session-only project chat, and a later Open shows it once', async () => {
  const findConversation = vi.fn(async () => transcript());
  const context = await setup({ findConversation });
  const { store, manager, client, controller, titleChat } = context;
  const { chat, channel } = await projectChat(context, SESSION);

  expect(await client.api.workspaces.regenerateTitle(chat.id)).toEqual({ name: 'Database migration plan' });

  expect(titleChat).toHaveBeenCalledWith(`User: ${TRANSCRIPT_TEXT}`);
  expect(findConversation).toHaveBeenCalledWith(expect.any(String), expect.anything(), { sessionId: SESSION });
  expect(manager.find(chat.id)?.sessionId).toBe(SESSION);
  controller.open(chat.id);
  await new Promise((resolve) => setImmediate(resolve));
  expect(findConversation).toHaveBeenCalledTimes(1);
  expect(logIds(store, channel)).toEqual(['t-1', `import-${SESSION}`]);
  expect(manager.find(chat.id)?.sessionId).toBe(SESSION);
});

it('keeps the transcript in the saved history when a message follows Regenerate', async () => {
  const context = await setup({ findConversation: async () => transcript() });
  const { home, store, session, client } = context;
  const { chat, channel } = await projectChat(context, SESSION);

  await client.api.workspaces.regenerateTitle(chat.id);
  store.dispatch({ type: 'chat', id: 'new-1', from: 'me', byAgent: false, text: 'One more thing', channel, ts: 2 });
  await session.stop();

  const reloaded = new WorkspaceManager(new WorkspaceStore(home));
  expect(reloaded.loadHistory<LogItem>(chat.id).map((l) => l.id)).toEqual(['t-1', `import-${SESSION}`, 'new-1']);
});

it.each([
  ['finds nothing', async () => undefined],
  ['throws', async () => { throw new Error('Unreadable transcript'); }],
])('lets a later Open read again when the first read %s', async (_name, firstRead) => {
  const findConversation = vi.fn<NonNullable<SessionOptions['findConversation']>>(async () => transcript());
  findConversation.mockImplementationOnce(firstRead);
  const context = await setup({ findConversation });
  const { store, manager, client, controller, titleChat } = context;
  const { chat, channel } = await projectChat(context, SESSION);

  await expect(client.api.workspaces.regenerateTitle(chat.id)).rejects.toThrow('no content');

  expect(titleChat).not.toHaveBeenCalled();
  expect(findConversation).toHaveBeenCalledTimes(1);
  controller.open(chat.id);
  expect(findConversation).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(logIds(store, channel)).toEqual(['t-1', `import-${SESSION}`]));
  expect(manager.find(chat.id)?.sessionId).toBe(SESSION);
});

it('does not read or bind a session for a project chat without one, and a later Open still does', async () => {
  const findConversation = vi.fn(async () => transcript('found-session'));
  const context = await setup({ findConversation });
  const { store, manager, client, controller, titleChat } = context;
  const { chat, channel } = await projectChat(context);

  await expect(client.api.workspaces.regenerateTitle(chat.id)).rejects.toThrow('no content');

  expect(findConversation).not.toHaveBeenCalled();
  expect(titleChat).not.toHaveBeenCalled();
  expect(manager.find(chat.id)?.sessionId).toBeUndefined();
  controller.open(chat.id);
  expect(findConversation).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(logIds(store, channel)).toEqual(['t-1', 'import-found-session']));
});

it('keeps saving a message that arrives while the transcript is being read', async () => {
  let finishRead = (_found: Conversation) => {};
  const findConversation = vi.fn(() => new Promise<Conversation>((resolve) => { finishRead = resolve; }));
  const context = await setup({ findConversation });
  const { home, store, session, client } = context;
  const { chat, channel } = await projectChat(context, SESSION);

  const regenerating = client.api.workspaces.regenerateTitle(chat.id);
  await vi.waitFor(() => expect(findConversation).toHaveBeenCalled());
  store.dispatch({ type: 'chat', id: 'during-read', from: 'me', byAgent: false, text: 'A message during the read', channel, ts: 2 });
  finishRead(transcript());
  await regenerating;
  await session.stop();

  const reloaded = new WorkspaceManager(new WorkspaceStore(home));
  expect(reloaded.loadHistory<LogItem>(chat.id).map((l) => l.id)).toEqual(['during-read']);
});
