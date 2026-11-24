import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { HonchoPictureResult, MemoryOverviewResult } from '../../../src/companion/calls';
import { Header, Screen, useScrolled } from '../components/Screen';
import { Card, T } from '../components/ui';
import { calls } from '../lib/link/calls';
import { useSupports } from '../lib/hooks';
import { store } from '../lib/store';

type MemoryViewResult = MemoryOverviewResult['user'];

const AUTHOR_WORDS: Readonly<Record<string, string>> = { you: 'You', agent: 'An agent' };

type MemoryEntryResult = MemoryViewResult['entries'][number];

const EntryList = ({ entries }: { readonly entries: readonly MemoryEntryResult[] }) => (
  <Card style={{ padding: 14, gap: 12 }}>
    {entries.map((entry) => (
      <View key={entry.id} style={{ gap: 2 }}>
        <T selectable>{entry.text}</T>
        <T v="caption">
          {AUTHOR_WORDS[entry.by] ?? entry.by} · {new Date(entry.at).toLocaleDateString()}
        </T>
      </View>
    ))}
  </Card>
);

/** One memory: the entries every run gets, then (BLG-123) the filed-away ones a run gets only when it is about them. */
const MemoryCard = ({ view }: { readonly view: MemoryViewResult }) => {
  const filed = view.entries.filter((e) => e.filed === true);
  const always = view.entries.filter((e) => e.filed !== true);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 6 }}>
        <T v="eyebrow">{view.label}</T>
        <T v="caption">
          {view.used} / {view.cap}
        </T>
      </View>
      {always.length ? <EntryList entries={always} /> : null}
      {filed.length ? (
        <>
          <T v="caption" style={{ paddingHorizontal: 6 }}>
            Filed away: a run gets these only when it is about them
          </T>
          <EntryList entries={filed} />
        </>
      ) : null}
    </View>
  );
};

/** Honcho's picture of you (BLG-101): what it inferred, read-only. Shown only when Honcho is on. */
const HonchoCard = ({ picture }: { readonly picture: HonchoPictureResult }) => (
  <View style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 6 }}>
      <T v="eyebrow">Honcho’s picture of you</T>
      {picture.at ? <T v="caption">{new Date(picture.at).toLocaleTimeString()}</T> : null}
    </View>
    <Card style={{ padding: 14, gap: 8 }}>
      <T selectable>{picture.text || 'Nothing yet: Honcho hasn’t learned enough about you.'}</T>
      {picture.error ? <T v="caption">Couldn’t refresh it: {picture.error}</T> : null}
    </Card>
    <T v="caption">Inferred by Honcho from your conversations. Your agents get it as background; the memory above wins where they disagree.</T>
  </View>
);

/** Settings › Memory (BLG-95): what your agents remember about you and each project. Read-only: you edit it on your Mac. */
export default function Memory() {
  const { scrolled, onScroll } = useScrolled();
  const insets = useSafeAreaInsets();
  const [memory, setMemory] = useState<MemoryOverviewResult>();
  const [picture, setPicture] = useState<HonchoPictureResult>();
  const supportsHoncho = useSupports('honchoPicture');

  useFocusEffect(
    useCallback(() => {
      void store.call<MemoryOverviewResult>(calls.memory(), { queue: false }).then(setMemory, () => undefined);
      if (supportsHoncho) void store.call<HonchoPictureResult>(calls.honchoPicture(), { queue: false }).then(setPicture, () => undefined);
    }, [supportsHoncho]),
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
        {picture?.enabled ? <HonchoCard picture={picture} /> : null}
      </ScrollView>
    </Screen>
  );
}
