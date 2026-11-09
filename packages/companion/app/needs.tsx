import { router } from 'expo-router';
import { ScrollView } from 'react-native';
import Animated, { LinearTransition, FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { kindOf, NeedsStack } from '../components/Needs';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Card, Row, T } from '../components/ui';
import { ago, useView, useAllNeeds } from '../lib/hooks';
import type { HomeView } from '../lib/link/protocol';

/** Everything that needs you: the stack to swipe through, and the list of all of it. */
export default function Needs() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const home = useView<HomeView>('home');
  const needs = useAllNeeds(home?.data.needsYou);
  return (
    <Screen>
      <Header scrolled={scrolled} back title="Needs you" at={home?.at} />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingTop: 16, paddingBottom: insets.bottom + 40 }}>
        <NeedsStack items={needs} />
        {needs.length > 1 ? (
          <Animated.View layout={LinearTransition.duration(180)} style={{ marginTop: 24 }}>
            <T v="eyebrow" style={{ paddingHorizontal: 20, marginBottom: 10 }}>
              All {needs.length}
            </T>
            <Card style={{ marginHorizontal: 16 }}>
              {needs.map((n, i) => {
                const k = kindOf(n.kind);
                return (
                  <Animated.View key={n.id} entering={FadeIn.duration(180)}>
                    <Row first={i === 0} Icon={k.Icon} tone={k.tone} label={n.title} sub={[k.label, n.from, ago(n.askedAt)].filter(Boolean).join(' · ')} onPress={() => router.push(`/need/${encodeURIComponent(n.id)}`)} />
                  </Animated.View>
                );
              })}
            </Card>
          </Animated.View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
