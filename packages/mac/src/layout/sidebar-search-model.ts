import type { AppState } from '../../../../src/core/store.js';
import { isLivePlan } from '../../../../src/core/plans/owner.js';
import { planTitle } from '../../../../src/core/plans/model.js';
import type { SearchHit } from '../../../../src/core/work-store.js';

/** Sent to focus the field (⌥⌘F). */
export const FOCUS_SIDEBAR_SEARCH = 'beluga:sidebar-search';
/** A message search reads every history file, so it waits for a pause and for a real word. */
export const MESSAGE_SEARCH_DEBOUNCE_MS = 200;
const MESSAGE_WORD_MIN = 3;
/** The rest are on the Search page. */
const MAX_MESSAGES = 30;

export type SidebarSearchSources = Pick<AppState, 'projects' | 'plans' | 'shared' | 'prs'>;

export type ChatTarget = { readonly kind: 'workspace'; readonly id: string } | { readonly kind: 'plan'; readonly id: string } | { readonly kind: 'shared'; readonly owner: string; readonly id: string };

export interface ChatMatch {
  readonly key: string;
  readonly target: ChatTarget;
  readonly label: string;
  /** "api · feat/auth · #412" */
  readonly detail: string;
}

/** A conversation or a message on one of your computers (BLG-785): which computer, and its page there. */
export interface RemoteMatch {
  readonly machine: { readonly id: string; readonly name: string };
  /** Its worktree there. */
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly hit?: SearchHit;
}

export type SidebarResult =
  | { readonly type: 'chat'; readonly key: string; readonly chat: ChatMatch }
  | { readonly type: 'remote'; readonly key: string; readonly match: RemoteMatch }
  /** `index`: the hit's place in `state.search.hits`, which opening it names. */
  | { readonly type: 'message'; readonly key: string; readonly hit: SearchHit; readonly index: number }
  | { readonly type: 'all'; readonly key: string };

/** What can be found by name: its label comes first, the other fields only have to contain a word. */
interface Candidate extends ChatMatch {
  readonly others: readonly string[];
}

/** The conversations whose name, branch, PR or project has every word; the best names first. */
export function matchChats(query: string, sources: SidebarSearchSources): ChatMatch[] {
  const words = wordsOf(query);
  if (!words.length) return [];
  const ranked = candidates(sources).flatMap((c) => {
    const name = c.label.toLowerCase();
    const fields = [name, ...c.others.map((o) => o.toLowerCase())];
    if (!words.every((w) => fields.some((f) => f.includes(w)))) return [];
    return [{ chat: c, rank: name.startsWith(words[0]!) ? 0 : words.every((w) => name.includes(w)) ? 1 : 2 }];
  });
  return ranked.sort((a, b) => a.rank - b.rank).map(({ chat: { key, target, label, detail } }) => ({ key, target, label, detail }));
}

/** Whether a query is worth a message search: one of its words has 3 letters or more. */
export const searchesMessages = (query: string): boolean => wordsOf(query).some((w) => w.length >= MESSAGE_WORD_MIN);

/** What the sidebar lists for a query: the chats, the messages found for this very query, the way to all of them. */
export function sidebarResults(query: string, chats: readonly ChatMatch[], search: Pick<AppState['search'], 'query' | 'hits'>, remote: { readonly chats: readonly RemoteMatch[]; readonly messages: readonly RemoteMatch[] } = { chats: [], messages: [] }): SidebarResult[] {
  const hits = searchesMessages(query) && search.query === query ? search.hits.slice(0, MAX_MESSAGES) : [];
  const tagged = (m: RemoteMatch, i: number): SidebarResult => ({ type: 'remote', key: `${m.machine.id}:${m.id}:${m.hit ? `${m.hit.ts}:${i}` : 'chat'}`, match: m });
  return [
    ...chats.map((chat): SidebarResult => ({ type: 'chat', key: chat.key, chat })),
    // Your computers' conversations after this Mac's, each tagged; their messages after this Mac's too.
    ...remote.chats.map(tagged),
    ...hits.map((hit, index): SidebarResult => ({ type: 'message', key: `${hit.channel}:${hit.ts}:${index}`, hit, index })),
    ...remote.messages.slice(0, MAX_MESSAGES).map(tagged),
    { type: 'all', key: 'all' },
  ];
}

/** Your computers' worktrees and chats with every word in their name or project (by computer, best names first). */
export function matchRemoteChats(query: string, sources: ReadonlyArray<{ readonly machine: { readonly id: string; readonly name: string }; readonly snapshot?: { readonly projects: ReadonlyArray<{ readonly name: string; readonly workspaces: ReadonlyArray<{ readonly id: string; readonly name: string; readonly kind: string }> }> } }>): RemoteMatch[] {
  const words = wordsOf(query);
  if (!words.length) return [];
  return sources.flatMap((src) =>
    (src.snapshot?.projects ?? []).flatMap((p) =>
      p.workspaces
        .filter((w) => w.kind !== 'main' && words.every((word) => w.name.toLowerCase().includes(word) || p.name.toLowerCase().includes(word)))
        .map((w) => ({ machine: { id: src.machine.id, name: src.machine.name }, id: w.id, label: w.name, detail: `${p.name} · ${src.machine.name}` })),
    ),
  );
}

/** The next selected row, going round at the ends. */
export const moveSelection = (selected: number, count: number, by: 1 | -1): number => (count ? (selected + by + count) % count : 0);

const wordsOf = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

function candidates({ projects, plans, shared, prs }: SidebarSearchSources): Candidate[] {
  const homes = new Set(plans.plans.filter(isLivePlan).map((p) => p.home));
  const workspaces = projects.flatMap((project) => {
    const projectName = project.root ? project.name : '';
    return project.workspaces
      .filter((w) => !w.archived && w.kind !== 'main' && !homes.has(`ws:${w.id}`))
      .map((w): Candidate => {
        const pr = prs[w.id];
        const number = pr ? `#${pr.number}` : '';
        return { key: `ws:${w.id}`, target: { kind: 'workspace', id: w.id }, label: w.name, detail: joined(projectName, w.branch, number), others: [w.branch ?? '', number, pr?.title ?? '', projectName] };
      });
  });
  const livePlans = plans.plans.filter(isLivePlan).map((plan): Candidate => {
    const projectName = projects.find((p) => p.id === plan.projectId)?.name ?? '';
    const number = plan.pr ? `#${plan.pr.number}` : '';
    return { key: `plan:${plan.id}`, target: { kind: 'plan', id: plan.id }, label: planTitle(plan), detail: joined(projectName, plan.branch, number), others: [plan.branch ?? '', number, plan.pr?.title ?? '', projectName] };
  });
  const sharedChats = shared.map((w): Candidate => ({ key: `shared:${w.owner}:${w.id}`, target: { kind: 'shared', owner: w.owner, id: w.id }, label: w.name, detail: joined(w.project, w.branch), others: [w.branch ?? '', w.project] }));
  return [...workspaces, ...livePlans, ...sharedChats];
}

const joined = (...parts: ReadonlyArray<string | undefined>): string => parts.filter(Boolean).join(' · ');
