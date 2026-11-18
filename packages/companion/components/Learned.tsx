import { Eraser, Lightbulb, Search, Sparkles } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import type { LearnedView } from '../lib/link/protocol';
import { color } from '../lib/theme';
import { T } from './ui';

/**
 * Under your agent's answer (1.63, BLG-102): what its run remembered, proposed or looked up, as on
 * the Mac but read-only. A memory write says whose memory and whether it was undone (Undo is on the
 * Mac); a proposed skill says when it waits for you in Needs You; a search says what it looked for.
 */

const ICON = { memory: Lightbulb, skill: Sparkles, recall: Search } as const;

const iconOf = (m: LearnedView): typeof Lightbulb => (m.kind === 'memory' && m.title === 'Forgot' ? Eraser : ICON[m.kind]);

const noteOf = (m: LearnedView): string | undefined => {
  if (m.kind === 'memory') return [m.scope, m.undone ? 'Undone on your Mac' : undefined].filter(Boolean).join(' · ') || undefined;
  if (m.kind === 'skill') return m.waiting ? 'Waits for you in Needs You' : 'Answered';
  return undefined;
};

export function LearnedChips({ items }: { items: readonly LearnedView[] }) {
  return (
    <View style={{ gap: 6 }} accessibilityLabel="What it remembered, proposed or looked up">
      {items.map((m) => {
        const Icon = iconOf(m);
        const note = noteOf(m);
        return (
          <View
            key={m.id}
            accessible
            accessibilityLabel={[m.title, m.text, note].filter(Boolean).join('. ')}
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12, backgroundColor: color.card, borderWidth: StyleSheet.hairlineWidth, borderColor: color.hairlineStrong }}
          >
            <Icon color={color.text2} size={14} style={{ marginTop: 2 }} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="caption" c={color.text} style={{ fontWeight: '600' }} numberOfLines={2}>
                {m.kind === 'recall' ? 'Searched past chats' : m.title}
              </T>
              {m.text ? (
                <T v="caption" c={color.text2} numberOfLines={3} style={m.undone ? { textDecorationLine: 'line-through' } : undefined}>
                  {m.kind === 'recall' ? `“${m.text}”` : m.text}
                </T>
              ) : null}
              {note ? <T v="caption">{note}</T> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
