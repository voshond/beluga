import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { Avatar, Card, Hairline, Press, T } from '../../components/ui';
import { useView } from '../../lib/hooks';
import type { PeopleView } from '../../lib/link/protocol';
import { color, TAB_BAR_H } from '../../lib/theme';
import { ChevronRight } from 'lucide-react-native';

const ORDER = { online: 0, away: 1, dnd: 2, offline: 3 } as const;
const WORD = { online: 'Online', away: 'Away', dnd: 'Busy', offline: 'Offline' } as const;
const UPDATE_WORD = { them: 'Needs a Beluga update', you: 'Update Beluga to reach them' } as const;

/** People: your friends, their presence and allowance. */
export default function People() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const view = useView<PeopleView>('people');
  const people = [...(view?.data.people ?? [])].sort((a, b) => ORDER[a.presence] - ORDER[b.presence]);
  return (
    <Screen>
      <Header scrolled={scrolled} title="People" at={view?.at} />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingTop: 8, paddingBottom: TAB_BAR_H + insets.bottom + 40 }}>
        <Card style={{ marginHorizontal: 16 }}>
          {people.map((p, i) => {
            const week = p.usage?.windows.find((w) => /week/i.test(w.label));
            return (
              <Animated.View key={p.peerId} entering={FadeIn.duration(180)}>
                {i ? <Hairline style={{ marginLeft: 72 }} /> : null}
                <Press scaleTo={0.985} onPress={() => router.push(`/person/${encodeURIComponent(p.peerId)}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
                  <Avatar name={p.name} size={44} presence={p.presence} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T v="body" style={{ fontWeight: '500' }} numberOfLines={1}>
                      {p.name}
                      {p.emoji && !p.update && p.presence !== 'offline' ? ` ${p.emoji}` : ''}
                    </T>
                    <T v="caption" numberOfLines={1}>
                      {p.update ? UPDATE_WORD[p.update] : WORD[p.presence]}
                      {p.note && !p.update ? ` · ${p.note}` : ''}
                    </T>
                  </View>
                  {week ? (
                    <T v="caption" style={{ fontVariant: ['tabular-nums'] }}>
                      {Math.round(week.pct)}%
                    </T>
                  ) : null}
                  <ChevronRight color={color.text3} size={18} />
                </Press>
              </Animated.View>
            );
          })}
        </Card>
      </ScrollView>
    </Screen>
  );
}
