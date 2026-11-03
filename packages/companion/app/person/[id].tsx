import { router, useLocalSearchParams } from 'expo-router';
import { Eye, FolderOpen, MessageCircle, Monitor, Sparkles, SquareTerminal } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chatHref, convHref } from '../../components/Conv';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { UsageBars } from '../../components/Usage';
import { Avatar, Card, haptic, IconBadge, Pill, Press, T, type Tone } from '../../components/ui';
import { useView } from '../../lib/hooks';
import { calls } from '../../lib/link/calls';
import type { PeopleView, Topic } from '../../lib/link/protocol';
import { store } from '../../lib/store';
import { color } from '../../lib/theme';

const WORD = { online: 'Online', away: 'Away', dnd: 'Busy', offline: 'Offline' } as const;
const UPDATE_WORD = { them: 'Needs a Beluga update', you: 'Update Beluga to reach them' } as const;
const OFFER: Record<string, { label: string; Icon: typeof Eye }> = { screen: { label: 'Screen', Icon: Eye }, commands: { label: 'Commands', Icon: SquareTerminal }, files: { label: 'Files', Icon: FolderOpen } };

/** A friend: Message, Ask their Claude, Screenshot of their desktop. */
export default function Person() {
  const { scrolled, onScroll } = useScrolled();
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const view = useView<PeopleView>('people');
  const p = view?.data.people.find((x) => x.peerId === decodeURIComponent(id ?? ''));
  if (!p) {
    return (
      <Screen>
        <Header back title="Friend" />
      </Screen>
    );
  }
  const canScreen = p.offers.includes('screen');
  const reachable = p.presence !== 'offline';

  const screenshot = async () => {
    haptic.commit();
    const r = await store.call<{ topic?: Topic }>(calls.screenshot(p.peerId, p.name)).catch((e: Error) => (store.toast({ text: e.message, tone: 'error' }), undefined));
    if (r?.topic) router.push(convHref(r.topic));
    else store.toast({ text: `Asked ${p.name}'s agent for a screenshot.`, tone: 'ok' });
  };

  const action = (Icon: typeof Sparkles, label: string, tone: Tone, onPress: () => void, disabled: boolean, delay: number) => (
    <Animated.View entering={FadeIn.duration(180)} style={{ flex: 1 }}>
      <Press disabled={disabled} onPress={onPress} accessibilityLabel={label} style={{ opacity: disabled ? 0.4 : 1 }}>
        <Card style={{ paddingVertical: 16, alignItems: 'center', gap: 10 }}>
          <IconBadge Icon={Icon} tone={tone} size={46} />
          <T v="callout" c={color.text} style={{ fontWeight: '600', textAlign: 'center' }} numberOfLines={1}>
            {label}
          </T>
        </Card>
      </Press>
    </Animated.View>
  );

  return (
    <Screen>
      <Header scrolled={scrolled} back title="" />
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        <View style={{ alignItems: 'center', paddingTop: 4 }}>
          <Animated.View entering={FadeIn.duration(320)}>
            <Avatar name={p.name} size={88} presence={p.presence} />
          </Animated.View>
          <T v="title" style={{ marginTop: 14 }}>
            {p.name}
            {p.emoji && !p.update && p.presence !== 'offline' ? ` ${p.emoji}` : ''}
          </T>
          <T v="callout" style={{ marginTop: 2 }}>
            {p.update ? UPDATE_WORD[p.update] : WORD[p.presence]}
            {p.note && !p.update ? ` · ${p.note}` : ''}
          </T>
          {p.beluga ? (
            <T v="caption" style={{ marginTop: 2 }}>
              Beluga {p.beluga}
            </T>
          ) : null}
        </View>

        <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, marginTop: 24 }}>
          {action(MessageCircle, 'Message', 'sky', () => p.chat && router.push(chatHref(p.chat)), !p.chat, 40)}
          {action(Sparkles, 'Ask their agent', 'peach', () => router.push({ pathname: '/ask', params: { friend: p.peerId } }), !reachable, 80)}
          {action(Monitor, 'Screenshot', 'lavender', () => void screenshot(), !canScreen || !reachable, 120)}
        </View>
        {!canScreen ? (
          <T v="caption" style={{ textAlign: 'center', marginTop: 8 }}>
            {p.name} hasn't shared their screen with your agent.
          </T>
        ) : null}

        {p.usage ? (
          <Animated.View entering={FadeIn.duration(180)} style={{ marginTop: 24, marginHorizontal: 16 }}>
            <Card style={{ padding: 16, gap: 14 }}>
              <T v="heading">Usage</T>
              <UsageBars usage={p.usage} />
            </Card>
          </Animated.View>
        ) : null}

        <Animated.View entering={FadeIn.duration(180)} style={{ marginTop: 24, paddingHorizontal: 20, gap: 10 }}>
          <T v="eyebrow">Your agent can use</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {p.offers.length ? p.offers.map((o) => <Pill key={o} label={OFFER[o]?.label ?? o} Icon={OFFER[o]?.Icon} tone="mint" />) : <T v="callout">Only chat</T>}
          </View>
        </Animated.View>
      </ScrollView>
    </Screen>
  );
}
