import { StyleSheet, View } from 'react-native';
import type { ChatMessageView } from '../lib/link/protocol';
import { color } from '../lib/theme';
import { Press, T, haptic } from './ui';

/**
 * Emoji reactions on a chat message (1.41, BLG-702), as on the Mac: a chip per emoji with its
 * count under the message, yours in the soft accent; a tap adds yours or takes it back. A
 * long-press on a chip says who. The quick row (your six most used) heads the message's sheet.
 */

/** The defaults, for a Mac that sends no quick row. */
const DEFAULT_QUICK = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

/** "You, bob and 2 others" */
const whoLine = (who: readonly string[], count: number): string => {
  const names = who.slice(0, 3);
  const rest = count - names.length;
  if (rest > 0) return `${names.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

export function ReactionChips({ reactions, mine, onToggle, onWho }: { reactions: NonNullable<ChatMessageView['reactions']>; mine: boolean; onToggle: (emoji: string, on: boolean) => void; onWho: (line: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, justifyContent: mine ? 'flex-end' : 'flex-start', marginHorizontal: 2 }}>
      {reactions.map((r) => {
        const line = `${whoLine(r.who, r.count)} reacted with ${r.emoji}`;
        return (
          <Press
            key={r.emoji}
            haptics={false}
            accessibilityLabel={`${r.emoji} ${r.count}: ${line}`}
            accessibilityState={{ selected: r.mine }}
            onPress={() => (haptic.tap(), onToggle(r.emoji, !r.mine))}
            onLongPress={() => (haptic.commit(), onWho(line))}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              height: 28,
              paddingLeft: 7,
              paddingRight: 9,
              borderRadius: 14,
              backgroundColor: r.mine ? `${color.info}1F` : color.card,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: r.mine ? `${color.info}66` : color.hairlineStrong,
            }}
          >
            <T v="body" style={{ fontSize: 15 }}>
              {r.emoji}
            </T>
            <T v="caption" c={r.mine ? color.info : color.text2} style={{ fontWeight: '700', fontSize: 12 }}>
              {r.count}
            </T>
          </Press>
        );
      })}
    </View>
  );
}

/** The quick row, at the top of a message's sheet: a tap reacts (or takes yours back) and closes it. */
export function QuickReactions({ quick, reactions, onPick }: { quick: readonly string[] | undefined; reactions: ChatMessageView['reactions']; onPick: (emoji: string, on: boolean) => void }) {
  const row = (quick?.length ? quick : DEFAULT_QUICK).slice(0, 6);
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 6, paddingBottom: 10 }} accessibilityLabel="React">
      {row.map((e) => {
        const yours = Boolean(reactions?.some((r) => r.emoji === e && r.mine));
        return (
          <Press key={e} haptics={false} accessibilityLabel={yours ? `Take back ${e}` : `React with ${e}`} onPress={() => (haptic.commit(), onPick(e, !yours))} style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: yours ? `${color.info}1F` : color.sunken }}>
            <T v="body" style={{ fontSize: 24 }}>
              {e}
            </T>
          </Press>
        );
      })}
    </View>
  );
}
