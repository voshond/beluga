import { type AgentRef, defaultAgentOf } from '../protocol.js';
import { shortVersion } from '../net/mesh/features.js';
import type { LiveClaude, PersonView, PresenceState } from '../net/mesh/views.js';
import { type TaskView, isFinal, oneLine, requestGist, targetLabel } from './gateway/model.js';

/**
 * Who's in a conversation with friends and what their Claudes are doing, and what waits on whom
 * (BLG-210), as plain words. The Mac's header, panel and waiting band draw these, and so does the
 * phone's chat (companion/views.ts). Browser-safe: no Node, no React.
 */

/** What someone's Claude is doing, as far as this conversation can tell. */
export type ClaudeState = 'working' | 'idle' | 'offline' | 'update';

export interface ChatPerson {
  readonly peerId: string;
  readonly name: string;
  /** You. */
  readonly me: boolean;
  readonly presence: PresenceState;
  readonly claude: ClaudeState;
  /** Which agent answers for them, and its model (BLG-80): their room card's default; unknown when they aren't in your room. */
  readonly agent?: AgentRef;
  /** What their Claude is on, in a few words ("run tests in ata-api"), while it works. */
  readonly doing?: string;
  /** Their Beluga's version ("1.2.0"), when their Mac said. */
  readonly version?: string;
  /** Your two Macs can't link until someone updates. */
  readonly update?: 'them' | 'you';
}

export interface ChatPeopleInput {
  readonly conversation: string;
  readonly self?: { readonly peerId: string; readonly name: string; readonly presence?: PresenceState; readonly version?: string; readonly agent?: AgentRef };
  /** Room cards (PeerInfo): which agent each person runs. */
  readonly peers?: readonly { readonly peerId: string; readonly agents?: readonly AgentRef[]; readonly defaultAgent?: AgentRef }[];
  /** Everyone else in it: the friend, or the channel's other members. */
  readonly others: readonly PersonView[];
  /** Claudes answering here now (stale ones already dropped). */
  readonly live?: readonly LiveClaude[];
  /** Your Mac's task book. */
  readonly tasks: readonly TaskView[];
  /** Your Claude's own run in this conversation (the log's running card). */
  readonly myRun?: { readonly working: boolean; readonly doing?: string };
}

/** A task belongs to this conversation: its card is here, or your Claude asked from here. */
export const taskIn = (t: Pick<TaskView, 'chat' | 'conversation'>, conversation: string): boolean => t.chat === conversation || t.conversation === conversation;

const online = (p: Pick<PersonView, 'online' | 'presence'>): PresenceState => (p.online && p.presence.state !== 'offline' ? p.presence.state : 'offline');
const versionOf = (p: Pick<PersonView, 'beluga'>): string | undefined => {
  const v = p.beluga ? shortVersion(p.beluga.version) : undefined;
  return v && v !== 'unknown' ? v : undefined;
};

/** You first, then the others in their order, each with their Claude's state here. */
export function chatPeople(input: ChatPeopleInput): ChatPerson[] {
  const { conversation, live = [], tasks } = input;
  const here = tasks.filter((t) => taskIn(t, conversation) && !isFinal(t.state));
  const out: ChatPerson[] = [];
  if (input.self) {
    const me = input.self.peerId;
    // Your Claude works here: its own run, an answer it writes, or a friend's task it runs for them.
    const forThem = here.find((t) => t.direction === 'received' && t.state === 'working');
    const answering = live.some((l) => l.peerId === me);
    const working = Boolean(input.myRun?.working) || answering || Boolean(forThem);
    const doing = input.myRun?.working ? input.myRun.doing : forThem ? `${requestGist(forThem, 60)} for ${forThem.peerName}` : answering ? 'answering' : undefined;
    out.push({
      peerId: me,
      name: input.self.name,
      me: true,
      presence: input.self.presence ?? 'online',
      claude: working ? 'working' : 'idle',
      ...(input.self.agent ? { agent: input.self.agent } : {}),
      ...(working && doing ? { doing: oneLine(doing, 80) } : {}),
      ...(input.self.version ? { version: shortVersion(input.self.version) } : {}),
    });
  }
  for (const p of input.others) {
    const presence = online(p);
    const version = versionOf(p);
    const task = here.find((t) => t.direction === 'sent' && t.peerId === p.peerId && t.state === 'working');
    const answering = live.some((l) => l.peerId === p.peerId);
    const claude: ClaudeState = p.update ? 'update' : presence === 'offline' ? 'offline' : task || answering ? 'working' : 'idle';
    const doing = claude === 'working' ? (task ? requestGist(task, 60) : 'answering') : undefined;
    const card = input.peers?.find((x) => x.peerId === p.peerId);
    out.push({
      peerId: p.peerId,
      name: p.name,
      me: false,
      presence,
      claude,
      ...(card ? { agent: defaultAgentOf(card) } : {}),
      ...(doing ? { doing: oneLine(doing, 80) } : {}),
      ...(version ? { version } : {}),
      ...(p.update ? { update: p.update } : {}),
    });
  }
  return out;
}

/** The header pill's words: "working", "idle", "offline · 1.1", "needs an update". */
export function claudePill(p: Pick<ChatPerson, 'claude' | 'version' | 'update'>): string {
  if (p.claude === 'update') return p.update === 'you' ? 'update yours' : 'needs an update';
  if (p.claude === 'offline') return p.version ? `offline · ${p.version}` : 'offline';
  return p.claude;
}

/** The panel's line under a name: "Claude: run tests", "Claude idle", "Offline · messages wait". */
export function claudeLine(p: Pick<ChatPerson, 'claude' | 'doing' | 'update' | 'me'>): string {
  if (p.claude === 'update') return p.update === 'you' ? 'Update Beluga to reach them' : 'Offline to you · their Beluga needs an update';
  if (p.claude === 'offline') return 'Offline · messages wait';
  if (p.claude === 'working') return p.doing && p.doing !== 'answering' ? `Agent: ${p.doing}` : p.doing === 'answering' ? 'Agent answering' : 'Agent working';
  return 'Agent idle';
}

/** The panel's version chip: "1.3.0", or "needs 1.3" when they're behind (your version, when known). */
export function versionChip(p: Pick<ChatPerson, 'version' | 'update'>, mine?: string): { readonly text: string; readonly behind: boolean } | undefined {
  if (p.update === 'them') return { text: mine ? `needs ${shortVersion(mine).split('.').slice(0, 2).join('.')}` : 'needs an update', behind: true };
  if (p.update === 'you') return { text: 'update yours', behind: true };
  return p.version ? { text: p.version, behind: false } : undefined;
}

/** "Mia is offline: this waits for them" under the message box, when someone won't get it now. */
export function offlineNote(people: readonly Pick<ChatPerson, 'name' | 'me' | 'claude'>[]): string | undefined {
  const away = people.filter((p) => !p.me && (p.claude === 'offline' || p.claude === 'update')).map((p) => p.name);
  if (!away.length) return undefined;
  if (away.length === 1) return `${away[0]} is offline: this waits for them`;
  if (away.length === 2) return `${away[0]} and ${away[1]} are offline: this waits for them`;
  return `${away.length} people are offline: this waits for them`;
}

// ---- what waits on whom

/** Something in this conversation that waits: on you (`on: 'you'`), or on someone else (their peer id). */
export interface WaitingItem {
  readonly on: 'you' | string;
  /** Who it waits on: "you", or their name. */
  readonly onName: string;
  readonly text: string;
  readonly kind: 'secret' | 'approval' | 'confirm' | 'question' | 'request';
  /** Where its card is: a task's card in the chat, or what holds up your Claude above the message box. */
  readonly target: { readonly kind: 'task'; readonly id: string } | { readonly kind: 'attention'; readonly id: string };
}

/** An approval or question of your own Claude's (the store's), as the waiting list needs it. */
export interface WaitingApproval {
  readonly id: string;
  readonly title: string;
  readonly channel?: string;
  readonly task?: string;
}

const who = (t: Pick<TaskView, 'peerName' | 'by'>): string => `${t.peerName}${t.by === 'agent' ? '’s agent' : ''}`;

/** What waits in this conversation: on you first (oldest first), then on the others. */
export function waitingIn(opts: { readonly conversation: string; readonly tasks: readonly TaskView[]; readonly approvals?: readonly WaitingApproval[] }): WaitingItem[] {
  const { conversation } = opts;
  const here = opts.tasks.filter((t) => taskIn(t, conversation) && !isFinal(t.state));
  const you: WaitingItem[] = [];
  const them: WaitingItem[] = [];
  for (const t of here) {
    const target = { kind: 'task' as const, id: t.id };
    if (t.direction === 'received' && t.state === 'awaiting_approval') {
      const text = t.secret ? `${who(t)} wants ${t.secret.label}` : t.kind === 'run' && t.command ? `${who(t)} wants to run ${oneLine(t.command, 60)}` : t.kind === 'file' && t.path ? `${who(t)} wants ${t.path.split(/[\\/]/).pop() || 'a file'}` : `${who(t)} wants to: ${requestGist(t, 70)}`;
      you.push({ on: 'you', onName: 'you', text, kind: t.secret ? 'secret' : 'approval', target });
    } else if (t.direction === 'sent' && t.state === 'confirm') {
      you.push({ on: 'you', onName: 'you', text: `Your agent wants to ask ${targetLabel(t)}`, kind: 'confirm', target });
    } else if (t.direction === 'sent' && t.question) {
      const q = t.question.questions[0]?.question ?? 'a question';
      you.push({ on: 'you', onName: 'you', text: `${t.peerName}’s agent asks: ${oneLine(q, 70)}`, kind: 'question', target });
    } else if (t.direction === 'sent' && (t.state === 'sent' || t.state === 'queued' || t.state === 'awaiting_approval')) {
      them.push({ on: t.peerId, onName: t.peerName, text: requestGist(t, 70), kind: 'request', target });
    }
  }
  for (const a of opts.approvals ?? []) {
    if (a.channel !== conversation || a.task) continue;
    you.push({ on: 'you', onName: 'you', text: `Your agent: ${oneLine(a.title, 70)}`, kind: 'approval', target: { kind: 'attention', id: a.id } });
  }
  return [...you, ...them];
}

/** "Waiting on you: Ata’s Claude wants your SSH key", "Waiting on Ata: run tests in ata-api". */
export const waitingLabel = (w: Pick<WaitingItem, 'on' | 'onName' | 'text'>): string => (w.on === 'you' ? `Waiting on you: ${w.text}` : `Waiting on ${w.onName}: ${w.text}`);
