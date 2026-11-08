import { router } from 'expo-router';
import { Check, CircleCheck, Flag, Hand, Monitor, MessageCircleQuestion, PenLine, PhoneIncoming, SquareTerminal, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { FadeIn, interpolate, type SharedValue, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { ago } from '../lib/hooks';
import { calls } from '../lib/link/calls';
import type { NeedsYou } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color, elevation, ink, spring, tint } from '../lib/theme';
import { Button, Card, haptic, IconBadge, More, Pill, Press, T, type Tone, toneBg, toneInk } from './ui';

/**
 * What needs you, as a stack of cards: swipe right to approve, left to decline, or tap the two
 * buttons; × dismisses one without answering it. Everything else (Always, the whole text, open
 * it, Dismiss again) is behind "•••" or a long press.
 * Questions and decisions answer with their choices; a kind this phone doesn't know is a plain
 * card that says "Open on your Mac" (docs/companion.md, staying in step).
 */

export const KNOWN = new Set(['approval', 'question', 'request', 'decision', 'confirm', 'call']);

export const kindOf = (kind: string): { label: string; tone: Tone; Icon: typeof Monitor } => {
  switch (kind) {
    case 'approval':
      return { label: 'Approval', tone: 'peach', Icon: SquareTerminal };
    case 'question':
      return { label: 'Question', tone: 'sky', Icon: MessageCircleQuestion };
    case 'request':
      return { label: 'Request', tone: 'lavender', Icon: Hand };
    case 'decision':
      return { label: 'Decision', tone: 'butter', Icon: Flag };
    case 'confirm':
      return { label: 'Confirm', tone: 'mint', Icon: CircleCheck };
    // Someone rings you (BLG-706): swipe right answers on your Mac, left declines.
    case 'call':
      return { label: 'Call', tone: 'mint', Icon: PhoneIncoming };
    default:
      return { label: 'On your Mac', tone: 'plain', Icon: Monitor };
  }
};

export const mainOf = (n: NeedsYou) => n.actions.find((a) => a.tone === 'main');
export const dangerOf = (n: NeedsYou) => n.actions.find((a) => a.tone === 'danger');
/** The action a choice makes: the Mac sends one `plain` action per option (labelled as it), or none. */
const choiceAction = (n: NeedsYou, label: string) => n.actions.find((a) => a.tone === 'plain' && (a.label === label || label.startsWith(a.label.replace(/…$/, ''))));
const isChoice = (n: NeedsYou, a: NeedsYou['actions'][number]) => !!n.choices?.some((c) => choiceAction(n, c.label) === a);
/** "Always" and the like: a plain action that isn't one of the choices. */
export const plainOf = (n: NeedsYou) => n.actions.find((a) => a.tone === 'plain' && !isChoice(n, a));

/** Several options can be picked (sent together through the `answer` template). */
export const multiPick = (n: NeedsYou): boolean => !!n.multi && !!n.answer?.picks && !!n.choices?.length;

/** Pick a choice: its own button if the Mac sent one, else through the `answer` template. */
export function choose(n: NeedsYou, label: string): boolean {
  const own = choiceAction(n, label);
  const c = own ? calls.action(n, own) : n.answer?.picks ? calls.answer(n, [label]) : undefined;
  if (!c) return false;
  haptic.success();
  void store.answer(n, c, `${label} · ${n.title}`);
  return true;
}

/** Send your own answer (picks or words) through the item's `answer` template. */
export function sendOwn(n: NeedsYou, value: string | readonly string[]): boolean {
  const c = calls.answer(n, value);
  if (!c) return false;
  haptic.success();
  void store.answer(n, c, `${n.answer?.label ?? 'Sent'} · ${n.title}`);
  return true;
}

/** Swipes decide only when the card has a yes (an approval, a request); otherwise they put it back. */
const decides = (n: NeedsYou): boolean => KNOWN.has(n.kind) && !n.choices?.length && !!mainOf(n);
/** What a swipe that way does: answer with the card's own button, or (no such button) put it back for later. */
const swipeAnswers = (n: NeedsYou, dir: 1 | -1): boolean => decides(n) && !!(dir === 1 ? mainOf(n) : dangerOf(n));

export function answer(n: NeedsYou, tone: 'main' | 'danger' | 'plain'): void {
  const action = tone === 'main' ? mainOf(n) : tone === 'danger' ? dangerOf(n) : plainOf(n);
  if (!action) return;
  if (tone === 'main') haptic.success();
  else haptic.commit();
  void store.answer(n, calls.action(n, action), `${action.label} · ${n.title}`);
}

const openDetail = (n: NeedsYou) => router.push(`/need/${encodeURIComponent(n.id)}`);

/** The card's face (also used whole on the need/[id] sheet). */
export function NeedFace({ item, full = false, onAnswered, more }: { readonly item: NeedsYou; readonly full?: boolean; /** After a choice was sent (the card can leave). */ readonly onAnswered?: () => void; readonly more?: boolean }) {
  const k = kindOf(item.kind);
  // Known kinds, and anything the Mac gave buttons or an answer template for, can be answered here.
  const known = KNOWN.has(item.kind) || item.actions.length > 0 || !!item.answer;
  const multi = multiPick(item);
  const [picked, setPicked] = useState<string[]>([]);
  const tap = (label: string) => {
    if (multi) {
      haptic.tap();
      setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
      return;
    }
    if (choose(item, label)) onAnswered?.();
    else openDetail(item);
  };
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <IconBadge Icon={k.Icon} tone={k.tone} size={34} />
        <View style={{ flex: 1 }}>
          <T v="callout" c={color.text} style={{ fontWeight: '600' }}>
            {k.label}
          </T>
          <T v="caption" numberOfLines={1}>
            {[item.from, item.thread, ago(item.askedAt)].filter(Boolean).join(' · ')}
          </T>
        </View>
        {more ? (
          <>
            {/* Dismiss: off the list (here and on the Mac) without answering it. */}
            <Press onPress={() => store.dismiss(item)} accessibilityLabel="Dismiss" hitSlop={8} style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }}>
              <X color={color.text3} size={18} />
            </Press>
            <More onPress={() => openDetail(item)} label="More options" />
          </>
        ) : null}
      </View>
      <T v="heading" numberOfLines={full ? undefined : 3} style={{ fontSize: 18, lineHeight: 24 }}>
        {item.title}
      </T>
      {item.detail ? (
        <T v="callout" numberOfLines={full ? undefined : 2}>
          {full ? item.detail : item.detail.replace(/\s*\n+\s*/g, ' · ')}
        </T>
      ) : null}
      {!full && (item.title.length > 110 || (item.detail?.length ?? 0) > 120) ? (
        <Press onPress={() => openDetail(item)} hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: -4 }}>
          <T v="caption" c={color.info} style={{ fontWeight: '700' }}>
            Read all
          </T>
        </Press>
      ) : null}
      {!known ? <Pill label="Open on your Mac" Icon={Monitor} style={{ alignSelf: 'flex-start' }} /> : null}
      {known && item.choices?.length ? (
        <View style={{ gap: 8, marginTop: 2 }}>
          {multi ? <T v="caption">Pick any</T> : null}
          {item.choices.slice(0, full ? 12 : 3).map((c) => {
            const on = picked.includes(c.label);
            return (
              <Press key={c.label} onPress={() => tap(c.label)} accessibilityLabel={c.label} accessibilityState={multi ? { checked: on } : undefined} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 14, backgroundColor: toneBg(k.tone) }}>
                {multi ? (
                  <View style={{ width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? toneInk(k.tone) : 'transparent', borderWidth: on ? 0 : 1.5, borderColor: toneInk(k.tone) }}>
                    {on ? <Check color={color.card} size={14} strokeWidth={2.2} /> : null}
                  </View>
                ) : null}
                <View style={{ flex: 1 }}>
                  <T v="callout" c={toneInk(k.tone)} numberOfLines={full ? undefined : 2} style={{ fontWeight: '600' }}>
                    {c.label}
                  </T>
                  {c.description && full ? (
                    <T v="caption" c={toneInk(k.tone)} style={{ marginTop: 2, opacity: 0.8 }}>
                      {c.description}
                    </T>
                  ) : null}
                </View>
              </Press>
            );
          })}
          {!full && item.choices.length > 3 ? (
            <Press onPress={() => openDetail(item)} style={{ alignSelf: 'flex-start', paddingVertical: 4 }}>
              <T v="caption" c={color.info} style={{ fontWeight: '600' }}>
                +{item.choices.length - 3} more
              </T>
            </Press>
          ) : null}
          {multi ? <Button label={`${item.answer?.label ?? 'Send'}${picked.length ? ` · ${picked.length}` : ''}`} Icon={Check} disabled={!picked.length} onPress={() => sendOwn(item, picked) && onAnswered?.()} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** Approve and Decline: the only buttons on the surface. */
export function NeedButtons({ item, onAnswer }: { readonly item: NeedsYou; readonly onAnswer: (tone: 'main' | 'danger') => void }) {
  const known = KNOWN.has(item.kind) || item.actions.length > 0;
  // With choices on the card, only the way out (Skip) stays as a button.
  const main = item.choices?.length ? undefined : mainOf(item);
  const danger = dangerOf(item);
  // Words only (no options, no yes): Reply opens the item's sheet to write them.
  const reply = !main && !item.choices?.length && item.answer?.text;
  if (!known || (!main && !danger && !reply)) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      {danger ? <Button quiet flex={1} Icon={X} label={danger.label} onPress={() => onAnswer('danger')} /> : null}
      {main ? <Button flex={1} Icon={Check} label={main.label} onPress={() => onAnswer('main')} /> : null}
      {reply ? <Button flex={1} Icon={PenLine} label="Reply" onPress={() => openDetail(item)} /> : null}
    </View>
  );
}

/** How far each card behind peeks out below the one in front, and how much smaller it is. */
const PEEK = 9;
const SHRINK = 0.04;

/**
 * One card of the stack. Every card lays its content out at its natural height (measured, and told
 * to the stack); the card itself is as tall as the front card, so the ones behind show only a
 * clean edge and never their own, different, size. Their content fades out; the front's in.
 */
function SwipeCard({ item, depth, frontH, onMeasure, onGone }: { readonly item: NeedsYou; readonly depth: number; readonly frontH: SharedValue<number>; readonly onMeasure: (id: string, h: number) => void; readonly onGone: (item: NeedsYou, dir: 1 | -1, answered: boolean) => void }) {
  const { width } = useWindowDimensions();
  const W = Math.min(width, 520);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const armed = useSharedValue(0);
  const d = useSharedValue(depth);
  const shown = useSharedValue(depth === 0 ? 1 : 0);
  useEffect(() => {
    d.value = withSpring(depth, spring.soft);
    shown.value = withTiming(depth === 0 ? 1 : 0, { duration: depth === 0 ? 260 : 120 });
    // Put back for later: it comes in again from behind the deck.
    if (depth > 0) {
      tx.value = withSpring(0, spring.soft);
      ty.value = 0;
    }
  }, [depth]);
  const top = depth === 0;
  const yes = swipeAnswers(item, 1);
  const no = swipeAnswers(item, -1);
  // Still the front card a moment after it was swiped away (the answer was refused, or nothing
  // took it): it comes back, never left off-screen with the card behind showing blank.
  const depthNow = useRef(depth);
  depthNow.current = depth;
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const comeBack = () => {
    tx.value = withSpring(0, spring.snappy);
    ty.value = withSpring(0, spring.snappy);
  };
  const watch = () =>
    setTimeout(() => {
      if (alive.current && depthNow.current === 0) comeBack();
    }, 700);

  const gone = (dir: 1 | -1) => {
    onGone(item, dir, false);
    watch();
  };
  const tick = () => haptic.tap();
  const fling = (dir: 1 | -1) => {
    tx.value = withTiming(dir * W * 1.3, { duration: 240 });
    setTimeout(() => onGone(item, dir, true), 180);
    watch();
  };

  const pan = usePanGesture({
    enabled: top,
    activeOffsetX: [-12, 12],
    failOffsetY: [-16, 16],
    onUpdate: (e) => {
      'worklet';
      tx.value = e.translationX;
      ty.value = e.translationY * 0.08;
      const over = Math.abs(e.translationX) > W * 0.28 ? 1 : 0;
      if (over !== armed.value) {
        armed.value = over;
        scheduleOnRN(tick);
      }
    },
    onDeactivate: (e) => {
      'worklet';
      const dir = tx.value > 0 ? 1 : -1;
      // A flick counts as much as a long drag.
      if (Math.abs(tx.value) > W * 0.28 || Math.abs(e.velocityX) > 800) {
        tx.value = withSpring(dir * W * 1.4, { velocity: e.velocityX, stiffness: 200, damping: 28, overshootClamping: true });
        scheduleOnRN(gone, dir as 1 | -1);
      } else {
        tx.value = withSpring(0, spring.snappy);
        ty.value = withSpring(0, spring.snappy);
      }
      armed.value = 0;
    },
  });

  const card = useAnimatedStyle(() => ({
    height: frontH.value,
    // Shrink toward the bottom edge, so the cards behind always peek out below, whatever the height.
    transformOrigin: 'center bottom',
    transform: [
      { translateY: d.value * PEEK + ty.value },
      { translateX: tx.value },
      { rotate: `${interpolate(tx.value, [-W, 0, W], [-4, 0, 4])}deg` },
      { scale: 1 - d.value * SHRINK },
    ],
    opacity: interpolate(d.value, [0, 2, 3], [1, 1, 0]),
  }));
  // As the card is pulled, its face steps back so the intent (the stamp in the middle) reads alone.
  const content = useAnimatedStyle(() => ({ opacity: shown.value * interpolate(Math.abs(tx.value), [0, W * 0.2], [1, 0.1], 'clamp') }));
  // The intent shows as a wash of its color over the card: mint to approve, rose to decline.
  const yesWash = useAnimatedStyle(() => ({ opacity: interpolate(tx.value, [0, W * 0.3], [0, 0.85], 'clamp') }));
  const noWash = useAnimatedStyle(() => ({ opacity: interpolate(tx.value, [-W * 0.3, 0], [0.85, 0], 'clamp') }));
  const main = mainOf(item);
  const danger = dangerOf(item);

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: 0, zIndex: 10 - depth }, card]} pointerEvents={top ? 'auto' : 'none'}>
        <Card style={{ flex: 1, overflow: 'hidden', ...(depth > 0 ? { backgroundColor: elevation[depth === 1 ? 'behind1' : 'behind2'].surface, borderColor: elevation[depth === 1 ? 'behind1' : 'behind2'].border } : null) }}>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: yes ? tint.mint : color.sunken }, yesWash]} />
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: no ? tint.rose : color.sunken }, noWash]} />
          <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: 0 }, content]} onLayout={(e) => onMeasure(item.id, e.nativeEvent.layout.height)}>
            <Pressable onPress={() => openDetail(item)} onLongPress={() => (haptic.commit(), openDetail(item))} delayLongPress={400} style={{ padding: 18, gap: 14 }}>
              <NeedFace item={item} more onAnswered={() => fling(1)} />
              <NeedButtons item={item} onAnswer={(t) => (answer(item, t), fling(t === 'main' ? 1 : -1))} />
            </Pressable>
          </Animated.View>
          <Animated.View pointerEvents="none" style={[styles.stamp, yesWash]}>
            <Pill label={yes ? (main?.label ?? 'Yes') : 'Later'} tone={yes ? 'mint' : 'plain'} Icon={yes ? Check : undefined} style={{ ...styles.stampPill, backgroundColor: elevation.card.surface, borderColor: yes ? ink.mint : color.hairlineStrong }} />
          </Animated.View>
          <Animated.View pointerEvents="none" style={[styles.stamp, noWash]}>
            <Pill label={no ? (danger?.label ?? 'No') : 'Later'} tone={no ? 'rose' : 'plain'} Icon={no ? X : undefined} style={{ ...styles.stampPill, backgroundColor: elevation.card.surface, borderColor: no ? ink.rose : color.hairlineStrong }} />
          </Animated.View>
        </Card>
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * The stack: as tall as the front card (measured; it springs to the next card's size when one
 * leaves), with two cards peeking out below it by a fixed edge.
 */
export function NeedsStack({ items }: { readonly items: readonly NeedsYou[] }) {
  const [order, setOrder] = useState<string[]>([]);
  const [heights, setHeights] = useState<Record<string, number>>({});
  // New items join at the back of the deck; answered ones leave it.
  const deck = useMemo(() => {
    const ids = items.map((n) => n.id);
    const kept = order.filter((id) => ids.includes(id));
    for (const id of ids) if (!kept.includes(id)) kept.push(id);
    return kept.map((id) => items.find((n) => n.id === id)!).filter(Boolean);
  }, [items, order]);

  // The deck as it is now, for a swipe's callback (which may hold an older render's closure).
  const deckNow = useRef(deck);
  deckNow.current = deck;
  const front = deck[0];
  const target = (front && heights[front.id]) || 220;
  const frontH = useSharedValue(target);
  useEffect(() => {
    frontH.value = withSpring(target, { stiffness: 260, damping: 30, mass: 0.9 });
  }, [target]);
  const behind = Math.min(2, Math.max(0, deck.length - 1));
  const box = useAnimatedStyle(() => ({ height: frontH.value + behind * PEEK + 6 }));

  const onMeasure = (id: string, h: number) => setHeights((prev) => (Math.abs((prev[id] ?? 0) - h) < 1 ? prev : { ...prev, [id]: Math.ceil(h) }));
  const onGone = (item: NeedsYou, dir: 1 | -1, answered: boolean) => {
    // Answered by a button or a choice: the store hides it already.
    if (answered) return;
    if (swipeAnswers(item, dir)) {
      answer(item, dir === 1 ? 'main' : 'danger');
      return;
    }
    // Nothing to decide by swiping (or no button that way): it goes to the back for later.
    haptic.tap();
    const ids = deckNow.current.map((n) => n.id);
    setOrder([...ids.filter((id) => id !== item.id), item.id]);
  };

  if (!deck.length) {
    return (
      <Animated.View entering={FadeIn.duration(140)} style={{ marginHorizontal: 16 }}>
        <Card style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <IconBadge Icon={CircleCheck} tone="mint" />
          <View style={{ flex: 1 }}>
            <T v="heading">All clear</T>
            <T v="callout">Nothing needs you.</T>
          </View>
        </Card>
      </Animated.View>
    );
  }
  return (
    <View>
      <Animated.View entering={FadeIn} style={[{ marginHorizontal: 16 }, box]}>
        {deck
          .slice(0, 3)
          .map((n, i) => <SwipeCard key={n.id} item={n} depth={i} frontH={frontH} onMeasure={onMeasure} onGone={onGone} />)
          .reverse()}
      </Animated.View>
      {deck.length > 1 ? (
        <T v="caption" style={{ textAlign: 'center', marginTop: 8 }}>
          1 of {deck.length}
        </T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stamp: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  stampPill: { height: 40, paddingHorizontal: 18, borderRadius: 20, borderWidth: 1.5, transform: [{ scale: 1.15 }] },
});
