import type { AppState, LogItem } from '../../../../src/core/store.js';
import type { MessageView } from '../../../../src/net/mesh/views.js';
import type { ChatPop } from './chat-pops.js';

/** How far back a call's chat is read for pop-ups (only the latest can pop up). */
const RECENT = 12;

/**
 * The others' latest messages in a call's conversation (BLG-717), as they pop up: a friend's or a
 * channel's from the network, the room's from its chat. Yours stay out (you wrote them); your
 * agent's answers come in, since you didn't.
 */
export function callChat(st: AppState, conversation: string): ChatPop[] {
  return conversation === 'room' ? roomChat(st.log, st.self?.peerId) : netChat(st.network.messages[conversation]);
}

/** The room's chat, from its log. */
export function roomChat(log: readonly LogItem[], me: string | undefined): ChatPop[] {
  const out: ChatPop[] = [];
  for (let i = log.length - 1; i >= 0 && out.length < RECENT; i--) {
    const m = log[i]!;
    if (m.type !== 'chat' || m.channel !== 'room' || (m.from === me && !m.byAgent) || !m.text.trim()) continue;
    out.push({ id: m.id, by: m.from, name: m.name, text: m.text, at: m.ts, ...(m.byAgent ? { agent: true } : {}) });
  }
  return out.reverse();
}

/** A friend's or a channel's chat. */
export function netChat(messages: readonly MessageView[] | undefined): ChatPop[] {
  const out: ChatPop[] = [];
  for (const m of (messages ?? []).slice(-RECENT)) {
    if ((m.mine && !m.claude) || m.status === 'locked') continue;
    const text = m.text.trim() || (m.files?.length ? (m.files.some((f) => f.mime?.startsWith('image/')) ? 'Sent a picture' : 'Sent a file') : '');
    if (!text) continue;
    const name = m.claude ? (m.mine ? 'Your agent' : `${m.name}’s agent`) : m.name;
    out.push({ id: m.id, by: m.from, name, text, at: m.ts, ...(m.claude ? { agent: true } : {}) });
  }
  return out;
}
