import { useMemo } from 'react';
import { type ChatPerson, type WaitingItem, chatPeople, waitingIn } from '@beluga/core/chat-people.js';
import { isRunning } from '@beluga/core/store.js';
import type { PersonView } from '@beluga/net/mesh/views.js';
import { APP_VERSION } from '../lib/boot.js';
import { useMyAgent } from '../lib/agent-words.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { liveIn } from './chat-model.js';
import { conversationOf } from './net-model.js';

/** Your Claude's run in this conversation right now: working, and on what. */
function useMyRun(id: string): { working: boolean; doing?: string } {
  return useApp((st) => {
    const run = [...st.log].reverse().find((l) => l.type === 'agent' && l.channel === id && l.owner === st.selfId && isRunning(l.status) && l.status !== 'queued' && l.status !== 'awaiting_approval');
    if (!run || run.type !== 'agent') return { working: false };
    const doing = run.steps.at(-1) ?? run.prompt;
    return { working: true, ...(doing ? { doing } : {}) };
  }, sameDeep);
}

/**
 * Who's in a conversation with friends and what their Claudes do (BLG-210), and what waits on whom
 * there: for the header's pills, the waiting band, the panel and the message box's offline note.
 */
export function useChatPeople(id: string): { people: ChatPerson[]; waiting: WaitingItem[] } {
  const target = conversationOf(id);
  const self = useApp((st) => st.network.self);
  const myAgent = useMyAgent();
  const peers = useApp((st) => st.peers, sameDeep);
  const others = useApp((st): readonly PersonView[] => {
    if (target?.kind === 'dm') {
      const f = st.network.friends.find((x) => x.peerId === target.peerId);
      return f ? [f] : [];
    }
    if (target?.kind === 'group') return st.network.groups.find((g) => g.id === target.groupId)?.members.filter((m) => !m.self) ?? [];
    return [];
  }, sameDeep);
  const live = useApp((st) => liveIn(st.network, id), sameDeep);
  const tasks = useApp((st) => st.gateway.tasks);
  const approvals = useApp((st) => st.approvals);
  const myRun = useMyRun(id);
  return useMemo(() => {
    const presence = self ? (self.appearOffline ? 'offline' : self.presence.state) : undefined;
    const people = chatPeople({
      conversation: id,
      ...(self ? { self: { peerId: self.peerId, name: self.name, version: APP_VERSION, agent: myAgent, ...(presence ? { presence } : {}) } } : {}),
      peers,
      others,
      live,
      tasks,
      myRun,
    });
    return { people, waiting: waitingIn({ conversation: id, tasks, approvals }) };
  }, [id, self, myAgent, peers, others, live, tasks, approvals, myRun]);
}

/** Scroll the conversation to a waiting thing's card (and flash it for a moment). */
export function showWaiting(w: WaitingItem): void {
  const el = w.target.kind === 'task' ? document.querySelector(`[data-task="${CSS.escape(w.target.id)}"]`) : document.querySelector('[data-attention]');
  if (!(el instanceof HTMLElement)) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.dataset.flash = 'true';
  setTimeout(() => delete el.dataset.flash, 1400);
}
