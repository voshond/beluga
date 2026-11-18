import { assistantChatOf } from '../../shared/assistant.js';
import { secretIn } from '../../shared/secret-text.js';
import type { Action, DomainState } from '../store.js';
import { HONCHO_USER_PEER, type PeerRole, agentPeerId, sessionIdOf } from './mapping.js';

export type ConversationKind = 'worktree' | 'chat' | 'main' | 'your-mac';

export type Conversation = {
  readonly channel: string;
  readonly session: string;
  readonly kind: ConversationKind;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly title?: string;
};

export type Outgoing = {
  readonly id: string;
  readonly conversation: Conversation;
  readonly peer: { readonly id: string; readonly role: PeerRole };
  readonly content: string;
  readonly ts: number;
  readonly metadata: Readonly<Record<string, string>>;
};

export type FilterContext = {
  readonly state: DomainState;
  readonly excluded: readonly string[];
  readonly since: number;
  readonly sharedWith: (channel: string) => boolean;
};

const DROPPED_BLOCK = /```(?:console|terminal|shell-session|output|beluga-[\w-]+)[^\n]*\n[\s\S]*?```/g;

export const cleanText = (text: string): string | undefined => {
  const kept = text.replace(DROPPED_BLOCK, '[…]').trim();
  if (!kept || kept === '[…]') return undefined;
  if (secretIn(kept)) return undefined;
  return kept;
};

export const conversationOf = (state: DomainState, channel: string): Conversation | undefined => {
  if (assistantChatOf(channel) !== undefined) return { channel, session: sessionIdOf(channel), kind: 'your-mac' };
  if (!channel.startsWith('ws:')) return undefined;
  const id = channel.slice(3);
  for (const p of state.projects) {
    const w = p.workspaces.find((x) => x.id === id);
    if (!w) continue;
    if (w.thread || w.purpose) return undefined;
    return { channel, session: sessionIdOf(channel), kind: w.kind, projectId: p.id, projectName: p.name, title: w.name };
  }
  return undefined;
};

const allowedConversation = (ctx: FilterContext, channel: string | undefined): Conversation | undefined => {
  if (!channel || channel === 'room') return undefined;
  if (ctx.sharedWith(channel)) return undefined;
  const conversation = conversationOf(ctx.state, channel);
  if (!conversation) return undefined;
  if (conversation.projectId && ctx.excluded.includes(conversation.projectId)) return undefined;
  return conversation;
};

export const pickOutgoing = (action: Action, ctx: FilterContext): Outgoing | undefined => {
  const self = ctx.state.selfId;
  if (!self) return undefined;
  if (action.type === 'chat') {
    if (action.from !== self || action.byAgent || action.via || action.fromApp || action.dialogue) return undefined;
    if (action.ts < ctx.since) return undefined;
    const conversation = allowedConversation(ctx, action.channel);
    if (!conversation) return undefined;
    const content = cleanText(action.text);
    if (!content) return undefined;
    return { id: action.id, conversation, peer: { id: HONCHO_USER_PEER, role: 'user' }, content, ts: action.ts, metadata: { kind: 'user' } };
  }
  if (action.type === 'agent_event') {
    if (action.event !== 'done' || action.owner !== self || action.requester !== self || action.via || action.fromChat) return undefined;
    if (action.ts < ctx.since) return undefined;
    const conversation = allowedConversation(ctx, action.channel);
    if (!conversation) return undefined;
    const content = cleanText(action.text);
    if (!content) return undefined;
    const runtime = action.agent?.runtime ?? 'claude';
    return {
      id: `run:${action.requestId}`,
      conversation,
      peer: { id: agentPeerId(runtime), role: 'agent' },
      content,
      ts: action.ts,
      metadata: { kind: 'agent', runtime, ...(action.agent?.model ? { model: action.agent.model } : {}) },
    };
  }
  return undefined;
};

export const sessionMetadata = (c: Conversation): Record<string, string> => ({
  kind: c.kind,
  channel: c.channel,
  ...(c.projectName ? { project: c.projectName } : {}),
  ...(c.title ? { title: c.title } : {}),
});
