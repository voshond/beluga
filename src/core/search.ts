import type { LogItem } from './store.js';
import { agentLabel } from '../shared/agent-label.js';
import type { SearchHit } from './work-store.js';

export interface SearchSource {
  readonly channel: string;
  /** "api › add-auth", "Chat", "the group chat" */
  readonly place: string;
  readonly items: readonly LogItem[];
  readonly archived?: boolean;
}

const MAX_HITS = 200;

const textOf = (item: LogItem): { who: string; text: string } | undefined => {
  if (item.type === 'chat') return { who: item.name, text: item.text };
  if (item.type === 'agent') return item.text ? { who: agentLabel(item.agent, item.ownerName, false), text: item.text } : undefined;
  return item.type === 'system' ? { who: '', text: item.text } : undefined;
};

/**
 * Find messages in every conversation. All words must appear (any order, any case);
 * newest first. Each hit remembers where its first word was found, for highlighting.
 */
export function searchConversations(query: string, sources: readonly SearchSource[]): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (!words.length) return [];
  const hits: SearchHit[] = [];
  for (const source of sources) {
    for (const item of source.items) {
      const found = textOf(item);
      if (!found) continue;
      const lower = found.text.toLowerCase();
      if (!words.every((w) => lower.includes(w) || found.who.toLowerCase().includes(w))) continue;
      const at = Math.max(0, lower.indexOf(words[0]!));
      // A shared chat's earlier message arrived later than it was said: the chat draws it at `said.ts`.
      const ts = (item.type === 'system' && item.said?.ts) || item.ts;
      hits.push({ channel: source.channel, place: source.place, who: found.who, text: found.text, at, ts, ...(item.id ? { id: item.id } : {}), ...(source.archived ? { archived: true } : {}) });
    }
  }
  return hits.sort((a, b) => b.ts - a.ts).slice(0, MAX_HITS);
}

/** A one-line excerpt around the match: "…the auth middleware rejects…" */
export function snippet(hit: Pick<SearchHit, 'text' | 'at'>, width: number): { before: string; match: string; after: string } {
  const flat = hit.text.replace(/\s+/g, ' ');
  // Positions shift when whitespace collapses; find the match again in the flat text.
  const original = hit.text.slice(hit.at).split(/\s+/)[0] ?? '';
  const at = Math.max(0, flat.toLowerCase().indexOf(original.toLowerCase()));
  const lead = Math.max(0, Math.floor(width / 3));
  const start = Math.max(0, at - lead);
  const shown = flat.slice(start, start + Math.max(10, width));
  const rel = at - start;
  const end = Math.min(shown.length, rel + original.length);
  return { before: (start > 0 ? '…' : '') + shown.slice(0, rel), match: shown.slice(rel, end), after: shown.slice(end) + (start + shown.length < flat.length ? '…' : '') };
}
