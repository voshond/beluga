import type { DomainState, View } from '../core/store.js';
import { FIRST_CHAT, assistantChatOf } from '../shared/assistant.js';
import { viewFor } from '../client/screen.js';
import { sentinelChatOf } from '../core/sentinel/model.js';

/**
 * "Open on your Mac" from the phone (BLG-40): what the Mac app's window shows for something the
 * phone has open (a conversation, a plan, a task, a friends' chat, something that needs you).
 * The daemon sends it to every screen as a `navigate` intent and asks the Mac app to raise its
 * window (its `raise` capability). Pure, so it's tested without a window.
 */

export interface OpenTarget {
  /** A phone topic: `conv:…`, `plan:…`, `task:…`, `chat:…`, `sentinel:…`, or a list (`work`, `plans`, `tasks`, `sentinels`, `chats`, `people`, `home`). */
  readonly topic?: string;
  /** A needs-you item's id, when it has no topic of its own ("request:<task>", "knock:<peer>", "join:<group>:<peer>"). */
  readonly need?: string;
}

/** The Mac's view for what the phone has open, or undefined when there's nothing by that name. */
export function macViewFor(state: DomainState, target: OpenTarget): View | undefined {
  const topic = target.topic;
  if (topic) {
    if (topic.startsWith('conv:')) {
      const channel = topic.slice(5);
      if (channel === 'room') return { kind: 'room' };
      const chat = assistantChatOf(channel);
      if (chat) {
        // One of Your Mac's chats (BLG-102); the first after it was deleted is the one open.
        if (state.assistant.chats.some((c) => c.id === chat)) return { kind: 'assistant', chat };
        return chat === FIRST_CHAT ? { kind: 'assistant' } : undefined;
      }
      const sentinelChat = sentinelChatOf(channel);
      if (sentinelChat) return { kind: 'sentinel_chat', chat: sentinelChat };
      if (channel.startsWith('task:')) return { kind: 'requests' };
      if (channel.startsWith('ws:')) {
        const id = channel.slice(3);
        // A project's main checkout: the chat its old conversation became, else the project's home (BLG-70).
        if (state.projects.some((p) => p.workspaces.some((w) => w.id === id))) return viewFor({ kind: 'workspace', id, tab: 'chat' }, state);
        const shared = state.shared.find((w) => w.id === id);
        return shared ? { kind: 'shared', owner: shared.owner, id, tab: 'chat' } : undefined;
      }
      return undefined;
    }
    if (topic.startsWith('plan:')) {
      const id = topic.slice(5);
      return state.plans.plans.some((p) => p.id === id) ? { kind: 'plan', id } : undefined;
    }
    if (topic.startsWith('task:')) {
      const id = topic.slice(5);
      return state.board.issues.some((i) => i.id === id) ? { kind: 'task', id } : undefined;
    }
    if (topic.startsWith('chat:')) return { kind: 'conversation', id: topic.slice(5) };
    if (topic.startsWith('sentinel:')) {
      const id = topic.slice('sentinel:'.length);
      return state.sentinel.items.some((i) => i.id === id) ? { kind: 'sentinel_page', id } : undefined;
    }
    if (topic === 'sentinels') return { kind: 'sentinel' };
    if (topic.startsWith('dashboard:')) {
      const id = topic.slice('dashboard:'.length);
      return state.sentinel.dashboards?.some((d) => d.id === id) ? { kind: 'dashboard', id } : undefined;
    }
    if (topic === 'tasks') return { kind: 'tasks' };
    if (topic === 'plans') return { kind: 'plans' };
    if (topic === 'work' || topic === 'home') return { kind: 'overview' };
    if (topic === 'chats' || topic === 'people') return { kind: 'overview' };
    return undefined;
  }
  const need = target.need ?? '';
  return need ? (needView(state, need) ?? { kind: 'overview' }) : undefined;
}

/**
 * Where a needs-you item (companion/needs-you.ts) is answered on the Mac, by its id: the page with
 * its buttons, when that's a page of its own (a team-up on Tasks, a sentinel's run, a shared plan).
 * Undefined: its topic says where (a conversation, a plan), or it has no page (a friend request: the sidebar).
 */
export function needView(state: DomainState, need: string): View | undefined {
  // A friend's request and the tasks between Claudes live in Requests; someone at the door, the room.
  if (need.startsWith('request:') || need.startsWith('confirm:') || need.startsWith('gwq:')) return { kind: 'requests' };
  if (need.startsWith('knock:')) return { kind: 'room' };
  const wtKnock = /^wt-knock:(.+)$/.exec(need);
  if (wtKnock) {
    const k = state.team.knocks?.find((x) => x.id === wtKnock[1]);
    return k ? { kind: 'workspace', id: k.workspaceId, tab: 'chat' } : undefined;
  }
  const approval = /^approval:(.+)$/.exec(need);
  if (approval) return state.approvals.find((a) => a.id === approval[1])?.task ? { kind: 'requests' } : undefined;
  const join = /^join:([^:]+):/.exec(need);
  if (join) return { kind: 'conversation', id: `group:${join[1]}` };
  const team = /^team:[^:]+:(.+)$/.exec(need);
  if (team) return { kind: 'tasks', projectId: team[1]! };
  const task = /^team-task:(.+)$/.exec(need);
  if (task) return state.board.issues.some((i) => i.id === task[1]) ? { kind: 'task', id: task[1]! } : { kind: 'tasks' };
  const shared = /^team-plan:([^:]+):([^:]+)/.exec(need);
  if (shared) return { kind: 'team_plan', owner: shared[1]!, id: shared[2]! };
  const run = /^sentinel:(.+)$/.exec(need);
  if (run) return state.sentinel.runs.some((r) => r.id === run[1]) ? { kind: 'sentinel_run', runId: run[1]! } : { kind: 'sentinel' };
  const plan = /^plan:([^:]+):/.exec(need);
  if (plan) return state.plans.plans.some((p) => p.id === plan[1]) ? { kind: 'plan', id: plan[1]! } : undefined;
  // A Toolbox card opens its project, whose Home lists the Toolbox.
  const toolbox = /^toolbox-(?:propose|detect):(.+)$/.exec(need);
  if (toolbox) {
    const root = state.toolboxSuggestions?.find((s) => s.id === toolbox[1])?.projectRoot;
    const project = root ? state.projects.find((p) => p.root === root) : undefined;
    return project ? { kind: 'project', id: project.id } : undefined;
  }
  return undefined;
}
