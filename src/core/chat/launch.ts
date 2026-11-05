import { mkdtempSync, rmSync } from 'node:fs';
import { agentLabel } from '../../shared/agent-label.js';
import type { AgentRef } from '../../protocol.js';
import os from 'node:os';
import path from 'node:path';
import { asks } from '../../net/mesh/extras.js';
import type { Mesh } from '../../net/mesh/mesh.js';
import { assistantOf } from '../assistant/registry.js';
import { gatewayOf } from '../gateway/registry.js';
import { belugaHome } from '../home.js';
import { watchNetwork } from '../network.js';
import type { Session } from '../session.js';
import { loadSettings, saveSettings } from '../settings.js';
import type { Store } from '../store.js';
import { trustOf } from '../trust.js';
import { ChatClaude } from './claude.js';
import { ChatFiles } from './files.js';
import { MainChannel } from './main-channel.js';
import { AnswerRequests } from './requests.js';
import { localMentions } from '../team/mentions.js';
import { chatNotesOf } from '../calls/launch.js';

/**
 * Chats for the daemon (the Mac app's Beluga), whenever the network is on: files in chats,
 * Claudes called into chats, and your main channel. The demo keeps its files in a temporary
 * folder; otherwise they live in ~/.beluga/chat-files/.
 */

export interface Chat {
  readonly mesh: Mesh;
  readonly files: ChatFiles;
  readonly claude: ChatClaude;
  readonly main: MainChannel;
  readonly requests: AnswerRequests;
  stop(): void;
}

const chats = new WeakMap<object, Chat>();

/** This session's chats, or a clear error while the network is off. */
export function chatOf(session: object): Chat {
  const chat = chats.get(session);
  if (!chat) throw new Error('Turn on talking with friends first');
  return chat;
}

export interface ChatHost {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
}

/** Start chats on a mesh: files, Claudes and the main channel, all mirrored into the store. */
export function startChat(opts: { mesh: Mesh; store: Store; session?: Session; dir: string; loadMain: () => string | undefined; saveMain: (id: string) => void }): Chat {
  const { mesh, store, session } = opts;
  const files = new ChatFiles({ mesh, dir: path.join(opts.dir, 'chat-files'), onState: (patch) => store.dispatch({ type: 'net_files', files: patch }) });
  const nameOf = (peerId: string): string => (peerId === mesh.peerId ? (mesh.summary().self?.name ?? 'you') : mesh.nameFor(peerId));
  const claude = new ChatClaude({
    mesh,
    files,
    // On your default agent (Claude when it can't), named by the one that answered (BLG-503).
    answer: session?.answersChats ? (req) => session.answerChat(req) : undefined,
    // You asking your own Claude: a real turn with its tools, in this chat (BLG-207).
    // It works in Your Mac's folder: only where that is (the Mac app's daemon).
    ...(session?.backend ? { act: (conversation: string, prompt: string) => session.host.runChat(conversation, prompt), canAct: () => Boolean(assistantOf(session)) } : {}),
    policy: () => store.getState().prefs.chatClaude,
    trustOf: (peerId) => trustOf(store.getState(), peerId),
    model: () => store.getState().prefs.model,
    ...(session ? { agent: () => session.agentRef } : {}),
    localize: (text) => localMentions(text, store.getState().board.issues),
    ...(session ? { notes: (conversation: string) => chatNotesOf(session, conversation) } : {}),
    handledFile: path.join(opts.dir, 'chat-claude.json'),
    onLive: (conversation, id, state, agent) => store.dispatch({ type: 'net_live', conversation, state, live: { peerId: mesh.peerId, name: nameOf(mesh.peerId), for: id, since: Date.now(), agent } }),
    onProblem: (conversation, text) => session?.notifier.notify({ kind: 'problems', title: `${agentLabel(session.agentRef, undefined, true, { capital: true })} couldn’t answer`, body: text, channel: conversation }),
  });
  // A friend's Claude answering your ask with something for their Mac: it goes there as your request (BLG-353).
  const requests = new AnswerRequests({
    mesh,
    ask: (input) => {
      const gateway = session && gatewayOf(session);
      if (!gateway) throw new Error('Tasks between agents are off here');
      return gateway.ask(input);
    },
    onProblem: (conversation, name, text) => session?.notifier.notify({ kind: 'problems', title: `Couldn’t send it to ${name}’s Mac`, body: text, channel: conversation }),
    handledFile: path.join(opts.dir, 'chat-requests.json'),
  });
  // Someone's Claude is answering: only for an ask you have that called their Claude in.
  const onLive = (e: { conversation: string; from: string; for: string; state: 'thinking' | 'idle'; agent?: AgentRef }): void => {
    const known = store.getState().network.messages[e.conversation]?.some((m) => m.id === e.for && asks(m, e.from));
    if (known || e.state === 'idle') store.dispatch({ type: 'net_live', conversation: e.conversation, state: e.state, live: { peerId: e.from, name: nameOf(e.from), for: e.for, since: Date.now(), ...(e.agent ? { agent: e.agent } : {}) } });
  };
  mesh.on('live', onLive);
  const main = new MainChannel(mesh, opts.loadMain, (id) => {
    opts.saveMain(id);
    store.dispatch({ type: 'net_main', groupId: id });
  });
  // New friends join your main channel; it shows as main once it exists.
  let friends = mesh.summary().friends.length;
  const onChange = (): void => {
    const now = mesh.summary().friends.length;
    if (now !== friends) {
      friends = now;
      main.sync();
    }
  };
  mesh.on('change', onChange);
  store.dispatch({ type: 'net_main', groupId: main.id });
  main.sync();
  return {
    mesh,
    files,
    claude,
    main,
    requests,
    stop: () => {
      claude.stop();
      requests.stop();
      files.stop();
      mesh.off('live', onLive);
      mesh.off('change', onChange);
    },
  };
}

export function launchChat(host: ChatHost): () => void {
  const { session, store } = host;
  const dir = host.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-chat-')) : belugaHome();
  let demoMain: string | undefined;
  let current: Chat | undefined;
  const off = watchNetwork(session, (service) => {
    if (current) {
      current.stop();
      chats.delete(session);
      current = undefined;
    }
    if (!service) return;
    current = startChat({
      mesh: service.mesh,
      store,
      session,
      dir,
      loadMain: () => (host.demo ? demoMain : loadSettings().mainChannel),
      saveMain: (id) => {
        if (host.demo) demoMain = id;
        else saveSettings({ mainChannel: id });
      },
    });
    chats.set(session, current);
  });
  return () => {
    off();
    current?.stop();
    chats.delete(session);
    if (host.demo) rmSync(dir, { recursive: true, force: true });
  };
}
