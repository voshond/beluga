import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MemoryOverviewResult } from '../../../src/companion/calls';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Card, T } from '../components/ui';
import { calls } from '../lib/link/calls';
import { store } from '../lib/store';

type MemoryViewResult = MemoryOverviewResult['user'];

const AUTHOR_WORDS: Readonly<Record<string, string>> = { you: 'You', agent: 'An agent' };

const MemoryCard = ({ view }: { readonly view: MemoryViewResult }) => (
  <View style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 6 }}>
      <T v="eyebrow">{view.label}</T>
      <T v="caption">
        {view.used} / {view.cap}
      </T>
    </View>
    <Card style={{ padding: 14, gap: 12 }}>
      {view.entries.map((entry) => (
        <View key={entry.id} style={{ gap: 2 }}>
          <T selectable>{entry.text}</T>
          <T v="caption">
            {AUTHOR_WORDS[entry.by] ?? entry.by} · {new Date(entry.at).toLocaleDateString()}
          </T>
        </View>
      ))}
    </Card>
  </View>
);

/** Settings › Memory (BLG-95): what your agents remember about you and each project. Read-only: you edit it on your Mac. */
export default function Memory() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const [memory, setMemory] = useState<MemoryOverviewResult>();

  useFocusEffect(
    useCallback(() => {
      void store.call<MemoryOverviewResult>(calls.memory(), { queue: false }).then(setMemory, () => undefined);
    }, []),
  );

  const projects = memory?.projects.filter((p) => p.entries.length) ?? [];

  return (
    <Screen>
      <Header scrolled={scrolled} back title="Memory" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 40, gap: 16 }}>
        <T v="caption">What your agents keep for later runs, on every runtime. Change or delete entries on your Mac: Settings › Skills & instructions › Memory.</T>
        {memory === undefined ? <T v="caption">Asking your Mac…</T> : null}
        {memory && memory.user.entries.length ? <MemoryCard view={memory.user} /> : null}
        {projects.map((view) => (
          <MemoryCard key={view.label} view={view} />
        ))}
        {memory && !memory.user.entries.length && !projects.length ? <T v="caption">Nothing remembered yet.</T> : null}
      </ScrollView>
    </Screen>
  );
}
