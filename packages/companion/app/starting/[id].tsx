import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { GitBranch, MessageCircleQuestion, MoonStar, Sparkles, Workflow } from 'lucide-react-native';
import { useCallback, useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { convHref } from '../../components/Conv';
import { Breathe, TypingDots } from '../../components/Live';
import { ProjectMark } from '../../components/ProjectMark';
import { Header, Screen } from '../../components/Screen';
import { Button, Card, IconBadge, T, type Tone } from '../../components/ui';
import { sends, type StartKind, useSend } from '../../lib/sends';
import { store } from '../../lib/store';
import { color } from '../../lib/theme';

/**
 * What you started from Ask, the moment you sent it: your words and what your Mac is doing with
 * them. When the Mac answers it becomes the conversation (or the plan); when it says no, it goes
 * back to Ask with your words still there, and says why (lib/sends.ts).
 */
const KIND: Record<StartKind, { Icon: typeof GitBranch; tone: Tone; title: string; doing: string }> = {
  worktree: { Icon: GitBranch, tone: 'mint', title: 'New worktree', doing: 'Making the worktree on your Mac' },
  plan: { Icon: Workflow, tone: 'butter', title: 'Advanced plan', doing: 'Your Mac is setting up the plan' },
  question: { Icon: MessageCircleQuestion, tone: 'sky', title: 'Question', doing: 'Opening the conversation on your Mac' },
  friend: { Icon: Sparkles, tone: 'lavender', title: 'Ask a friend', doing: 'Sending it to their agent' },
};

export default function Starting() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const s = useSend(id);
  useEffect(() => (id ? sends.showing(id) : undefined), [id]);

  // Only while it's the screen in front (another may have opened over it); else when you come back to it.
  useFocusEffect(
    useCallback(() => {
      if (!s) return;
      if (s.state === 'sent' && (s.topic || s.plan)) {
        // It's there: this screen becomes it.
        router.replace((s.plan ? `/plan/${encodeURIComponent(s.plan)}` : convHref(s.topic!, s.on)) as never);
      } else if (s.state === 'failed' && s.start) {
        // Undone: back where you were, Ask open again with your words.
        store.toast({ text: s.error ?? "It didn't start.", tone: 'error' });
        router.back();
        setTimeout(() => (sends.remove(s.id), router.push({ pathname: '/ask', params: { text: s.text, to: s.start!.target, how: s.start!.kind } })), 80);
      }
    }, [s?.state]),
  );

  const k = KIND[s?.start?.kind ?? 'question'];
  const waiting = s?.state === 'waiting';
  return (
    <Screen>
      <Header back eyebrow={s?.start?.project ?? s?.start?.label} title={s?.start?.plan ? `${k.title} · plan first` : k.title} lead={s?.start?.project ? <ProjectMark name={s.start.project} icon={s.start.icon} size={30} /> : <IconBadge Icon={k.Icon} tone={k.tone} size={30} />} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 8, gap: 14 }}>
        {s ? (
          <>
            <Animated.View entering={FadeIn.duration(180)} style={{ alignItems: 'flex-end', paddingLeft: 48 }}>
              <View style={{ backgroundColor: color.card, borderRadius: 20, borderBottomRightRadius: 6, paddingVertical: 10, paddingHorizontal: 14 }}>
                <T v="body" style={{ fontSize: 15 }}>
                  {s.text}
                </T>
              </View>
            </Animated.View>
            <Animated.View entering={FadeIn.delay(120).duration(220)}>
              <Card style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {waiting ? <IconBadge Icon={MoonStar} tone="sky" size={30} /> : <IconBadge Icon={k.Icon} tone={k.tone} size={30} />}
                <View style={{ flex: 1, gap: 4 }}>
                  <Breathe on={!waiting}>
                    <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
                      {waiting ? 'Waiting for your Mac' : k.doing}
                    </T>
                  </Breathe>
                  <T v="caption">{waiting ? 'It goes as soon as your Mac answers.' : 'This becomes the conversation in a moment.'}</T>
                </View>
                {waiting ? null : <TypingDots tone={k.tone} />}
              </Card>
            </Animated.View>
            {waiting ? <Button label="Don't send it" quiet onPress={() => (sends.remove(s.id), router.back())} /> : null}
          </>
        ) : (
          <T v="callout" style={{ textAlign: 'center', marginTop: 40 }}>
            It's in Work now.
          </T>
        )}
      </ScrollView>
    </Screen>
  );
}
