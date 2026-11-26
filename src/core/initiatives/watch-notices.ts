import type { NoticeEvent } from '../notify.js';
import { type InitiativesSlice, initiativeChatChannel } from './model.js';
import { WATCH_CHAT } from './watches.js';

const firstLine = (text: string, max = 140): string => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * News a follow-up brought in since the last state: one notice each, opening the initiative's
 * Follow-ups chat. Only for initiatives already known (the first load is no news), once per item.
 */
export const followUpNews = (prev: InitiativesSlice, next: InitiativesSlice): NoticeEvent[] => {
  if (prev.initiatives === next.initiatives) return [];
  const out: NoticeEvent[] = [];
  for (const item of next.initiatives.items) {
    const was = prev.initiatives.items.find((i) => i.slug === item.slug);
    if (!was || was.watches === item.watches) continue;
    const seen = new Set((was.watches ?? []).flatMap((w) => w.news.map((n) => `${w.id}:${n.at}`)));
    for (const watch of item.watches ?? []) {
      for (const news of watch.news) {
        if (news.read || seen.has(`${watch.id}:${news.at}`)) continue;
        out.push({
          kind: 'mentions',
          tag: 'message',
          title: `${item.name}: ${news.from ? `${news.from} answered` : 'news on a follow-up'}`,
          body: firstLine(news.text),
          channel: initiativeChatChannel(item.slug, WATCH_CHAT),
          key: `follow-up:${item.slug}:${watch.id}:${news.at}`,
        });
      }
    }
  }
  return out;
};
