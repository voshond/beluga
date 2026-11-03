import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowRight, ChevronLeft, Keyboard, ScanLine } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown, FadeInUp, FadeOut, useAnimatedScrollHandler, useSharedValue, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CODE_LENGTH, CodeBoxes } from '../components/CodeBoxes';
import { KeyboardLift } from '../components/KeyboardLift';
import { Mark } from '../components/Mark';
import { WhySheet } from '../components/WhySheet';
import { Burst, Dots, Finding, Illustration, MacPairing, Step, Wash } from '../components/onboarding';
import { Button, Card, haptic, IconBadge, Press, T } from '../components/ui';
import type { Diagnosis } from '../lib/link/diagnose';
import { DEVICE_LINK } from '../lib/link/protocol';
import type { PairStep } from '../lib/link/transport';
import { type Mode, store } from '../lib/store';
import { color, ink } from '../lib/theme';

/**
 * Pairing, staged like the Mac's onboarding (packages/mac/src/onboarding) in the phone's pastel
 * language: a short intro you swipe through (the mark arriving on still water, then what the app
 * is for), "Connect your Mac" with a drawing of where the code is on the Mac, the code typed into
 * twelve boxes above the keyboard (or scanned), the four pictures to compare, and a burst when
 * you're paired.
 */
type Stage = 'intro' | 'connect' | 'scan' | 'code' | 'dialing' | 'waiting' | 'paired' | 'failed';

const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const PAGES = [
  { eyebrow: 'Beluga for your phone', title: 'Your Mac,\nin your pocket', body: 'What your agent is doing on your Mac, wherever you are.' },
  { eyebrow: 'Needs you', title: 'Answer in\na swipe', body: 'Approvals, questions and requests come to you. Right to approve, left to decline.' },
  { eyebrow: 'Ask', title: 'Ask your Mac\nanything', body: 'Start work from the couch. The answer, pictures and files come back here.' },
] as const;

export default function Pair() {
  const insets = useSafeAreaInsets();
  const [stage, setStage] = useState<Stage>('intro');
  const [fingerprint, setFingerprint] = useState('');
  const [reason, setReason] = useState('');
  const [diagnosis, setDiagnosis] = useState<Diagnosis | undefined>(undefined);
  const [why, setWhy] = useState(false);
  const last = useRef<{ mode: Mode; input: { link?: string; code?: string } } | undefined>(undefined);
  const [macName, setMacName] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState(false);
  const run = useRef<{ cancel(): void } | undefined>(undefined);
  const scanned = useRef(false);

  useEffect(() => () => run.current?.cancel(), []);

  // Opened with a pairing link (the Mac sent it over the USB cable, BLG-190): pair as if it was scanned.
  const { link: given } = useLocalSearchParams<{ link?: string }>();
  useEffect(() => {
    if (!given || scanned.current || !DEVICE_LINK.test(given)) return;
    scanned.current = true;
    start('bare', { link: given });
  }, [given]);

  const start = (mode: Mode, input: { link?: string; code?: string }) => {
    run.current?.cancel();
    last.current = { mode, input };
    haptic.commit();
    const name = Device.deviceName ?? Device.modelName ?? (Platform.OS === 'web' ? 'This browser' : 'Phone');
    run.current = store.pair(mode, { ...input, name }, (s: PairStep) => {
      if (s.step === 'dialing') setStage('dialing');
      else if (s.step === 'waiting') {
        setFingerprint(s.fingerprint);
        setStage('waiting');
        haptic.tap();
      } else if (s.step === 'paired') {
        setMacName(s.pairing.macName);
        setStage('paired');
        haptic.success();
        setTimeout(() => router.replace('/(tabs)'), 2200);
      } else {
        setReason(s.diagnosis?.title ?? s.reason);
        setDiagnosis(s.diagnosis);
        // A wrong code is said under the boxes; anything else (the network, the Mac) gets the full explanation.
        const codeProblem = input.code && (!s.diagnosis || s.diagnosis.problem === 'pairing-wrong' || s.diagnosis.problem === 'pairing-gone');
        setStage(codeProblem ? 'code' : 'failed');
        if (codeProblem) setCodeError(true);
        haptic.warn();
      }
    });
  };
  const sendCode = (v: string) => {
    if (v.length !== CODE_LENGTH) return;
    setCodeError(false);
    start('bare', { code: v.replace(/(.{4})(?=.)/g, '$1-') });
  };

  const back = (to: Stage) => {
    run.current?.cancel();
    run.current = undefined;
    scanned.current = false;
    setStage(to);
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      {stage === 'intro' ? <Intro onDone={() => setStage('connect')} onDemo={() => start('demo', {})} /> : null}

      {stage === 'connect' ? (
        <Animated.View key="connect" entering={FadeIn.duration(260)} style={{ flex: 1 }}>
          <Wash tones={['lavender', 'sky']} height={360} />
          <View style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16, paddingHorizontal: 24 }}>
            <Back onPress={() => back('intro')} />
            <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', gap: 22, paddingVertical: 12 }} showsVerticalScrollIndicator={false}>
              <Animated.View entering={FadeInDown.delay(60).duration(500).easing(EASE)}>
                <T v="eyebrow" c={ink.lavender}>
                  On your Mac
                </T>
                <T v="hero" style={{ marginTop: 6 }}>
                  Connect your Mac
                </T>
              </Animated.View>
              <Animated.View entering={FadeInDown.delay(160).duration(560).easing(EASE)} style={{ alignItems: 'center' }}>
                <MacPairing />
              </Animated.View>
              <View style={{ gap: 14 }}>
                <Step n={1} text="Open Beluga on your Mac" delay={260} />
                <Step n={2} text="Settings › Phone › Pair a Phone (on a server: beluga pair)" delay={340} />
                <Step n={3} text="Scan the code, or type it here" delay={420} />
              </View>
            </ScrollView>
            <Animated.View entering={FadeInUp.delay(480).duration(500).easing(EASE)} style={{ gap: 10 }}>
              <Button label="Scan the code" Icon={ScanLine} onPress={() => setStage('scan')} />
              <Button label="Type the code" Icon={Keyboard} quiet onPress={() => setStage('code')} />
            </Animated.View>
          </View>
        </Animated.View>
      ) : null}

      {stage === 'scan' ? (
        <Scan
          onBack={() => back('connect')}
          onCode={() => setStage('code')}
          onLink={(link) => {
            if (scanned.current) return;
            scanned.current = true;
            start('bare', { link });
          }}
        />
      ) : null}

      {stage === 'code' ? (
        <KeyboardLift>
          <Animated.View key="code" entering={FadeIn.duration(240)} style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16, paddingHorizontal: 24 }}>
            <Back onPress={() => back('connect')} />
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', gap: 22, paddingVertical: 12 }}>
              <Animated.View entering={FadeInDown.delay(40).duration(420).easing(EASE)} style={{ gap: 8 }}>
                <IconBadge Icon={Keyboard} tone="sky" size={48} square />
                <T v="title" style={{ marginTop: 6 }}>
                  Type the code
                </T>
                <T v="callout">It's under the QR on your Mac, in Settings › Phone. It works for ten minutes.</T>
              </Animated.View>
              <Animated.View entering={FadeInDown.delay(120).duration(420).easing(EASE)} style={{ gap: 12 }}>
                <CodeBoxes value={code} onChange={(v) => (setCode(v), setCodeError(false))} onDone={sendCode} error={codeError} />
                {codeError ? (
                  <Animated.View entering={FadeIn}>
                    <T v="callout" c={color.error} style={{ textAlign: 'center' }}>
                      {reason || "That code didn't work. Check it, or make a new one on your Mac."}
                    </T>
                  </Animated.View>
                ) : (
                  <T v="caption" style={{ textAlign: 'center' }}>
                    Pasting the whole code works too
                  </T>
                )}
              </Animated.View>
            </ScrollView>
            <Button label="Continue" Icon={ArrowRight} disabled={code.length !== CODE_LENGTH} onPress={() => sendCode(code)} />
          </Animated.View>
        </KeyboardLift>
      ) : null}

      {stage === 'dialing' || stage === 'waiting' ? (
        <Animated.View key="wait" entering={FadeIn.duration(300)} style={{ flex: 1 }}>
          <Wash tones={['sky', 'mint']} height={420} />
          <View style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24, paddingHorizontal: 24 }}>
            <Back label="Cancel" onPress={() => back('connect')} />
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 26 }}>
              {stage === 'dialing' ? (
                <>
                  <Finding />
                  <View style={{ alignItems: 'center', gap: 6 }}>
                    <T v="title">Finding your Mac</T>
                    <T v="callout">Encrypted end to end, whichever way it gets there.</T>
                  </View>
                </>
              ) : (
                <>
                  <View style={{ alignItems: 'center', gap: 6 }}>
                    <T v="eyebrow" c={ink.sky}>
                      Check your Mac
                    </T>
                    <T v="title" style={{ textAlign: 'center' }}>
                      Same four on both?
                    </T>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    {fingerprint
                      .split(/\s+/)
                      .filter(Boolean)
                      .slice(0, 4)
                      .map((e, i) => (
                        <Animated.View key={i} entering={ZoomIn.delay(100 + i * 110).springify().stiffness(240).damping(16)}>
                          <Card style={{ width: 70, height: 84, alignItems: 'center', justifyContent: 'center' }}>
                            <T style={{ fontSize: 36, lineHeight: 44 }}>{e}</T>
                          </Card>
                        </Animated.View>
                      ))}
                  </View>
                  <Animated.View entering={FadeIn.delay(700)} style={{ alignItems: 'center', gap: 6 }}>
                    <T v="callout" style={{ textAlign: 'center', maxWidth: 280 }}>
                      If they match, click Pair on your Mac.
                    </T>
                    <Finding />
                  </Animated.View>
                </>
              )}
            </View>
          </View>
        </Animated.View>
      ) : null}

      {stage === 'paired' ? (
        <Animated.View key="ok" entering={FadeIn.duration(200)} style={{ flex: 1 }}>
          <Wash tones={['mint', 'sky']} height={520} />
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 24 }}>
            <Burst />
            <Animated.View entering={FadeInDown.delay(350).duration(520).easing(EASE)} style={{ alignItems: 'center', gap: 6 }}>
              <T v="hero">You're paired</T>
              <T v="body" c={color.text2}>
                with {macName}
              </T>
            </Animated.View>
          </View>
        </Animated.View>
      ) : null}

      {stage === 'failed' ? (
        <Animated.View key="fail" entering={FadeInDown.duration(300)} style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16, paddingHorizontal: 24 }}>
          <Back onPress={() => back('connect')} />
          <View style={{ flex: 1, justifyContent: 'center', gap: 10 }}>
            <IconBadge Icon={ScanLine} tone="peach" size={52} square />
            <T v="title">{diagnosis?.title ?? "That didn't work"}</T>
            <T v="callout">{diagnosis ? diagnosis.body : reason}</T>
            {diagnosis?.tryThis ? (
              <T v="callout" c={color.text}>
                {diagnosis.tryThis}
              </T>
            ) : null}
            {diagnosis ? (
              <Press onPress={() => setWhy(true)} hitSlop={8} style={{ alignSelf: 'flex-start', paddingVertical: 6 }}>
                <T v="callout" c={ink.sky} style={{ fontWeight: '600' }}>
                  Why?
                </T>
              </Press>
            ) : null}
          </View>
          <Button label="Try again" onPress={() => (diagnosis?.retry && last.current ? start(last.current.mode, last.current.input) : back('connect'))} />
          <WhySheet diagnosis={diagnosis} visible={why} onDismiss={() => setWhy(false)} onRetry={() => last.current && start(last.current.mode, last.current.input)} />
        </Animated.View>
      ) : null}
    </View>
  );
}

/** The intro: three pages you swipe (or tap through), each a picture, a title and a line. */
function Intro({ onDone, onDemo }: { onDone: () => void; onDemo: () => void }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const W = Math.min(width, 520);
  const progress = useSharedValue(0);
  const [page, setPage] = useState(0);
  const scroll = useRef<React.ComponentRef<typeof Animated.ScrollView>>(null);
  const onScroll = useAnimatedScrollHandler((e) => {
    progress.value = e.contentOffset.x / W;
  });
  const last = page === PAGES.length - 1;
  return (
    <View style={{ flex: 1 }}>
      <Wash tones={page === 0 ? ['sky', 'lavender'] : page === 1 ? ['mint', 'sky'] : ['peach', 'lavender']} height={480} />
      <Animated.View entering={FadeIn.delay(200).duration(500)} style={{ paddingTop: insets.top + 14, paddingHorizontal: 24, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Mark size={28} intro={false} />
        <T v="eyebrow" c={color.text} style={{ letterSpacing: 2.5, fontWeight: '700' }}>
          BELUGA
        </T>
        <View style={{ flex: 1 }} />
        {!last ? (
          <Press onPress={onDone} hitSlop={10}>
            <T v="callout" c={color.text2} style={{ fontWeight: '600' }}>
              Skip
            </T>
          </Press>
        ) : null}
      </Animated.View>
      <Animated.ScrollView
        ref={scroll}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(e) => {
          const p = Math.round(e.nativeEvent.contentOffset.x / W);
          if (p !== page) haptic.tap();
          setPage(p);
        }}
        style={{ flex: 1 }}
      >
        {PAGES.map((p, i) => (
          <View key={i} style={{ width: W, flex: 1, paddingHorizontal: 28, justifyContent: 'center' }}>
            <View style={{ height: 300, alignItems: 'center', justifyContent: 'center' }}>{i === 0 || page >= i - 1 ? <Illustration page={i as 0 | 1 | 2} /> : null}</View>
            <Animated.View entering={i === 0 ? FadeInDown.delay(900).duration(700).easing(EASE) : undefined} style={{ marginTop: 18 }}>
              <T v="eyebrow" c={i === 0 ? ink.sky : i === 1 ? ink.mint : ink.peach}>
                {p.eyebrow}
              </T>
              <T v="hero" style={{ marginTop: 8, fontSize: 36, lineHeight: 41, letterSpacing: -0.9 }}>
                {p.title}
              </T>
              <T v="body" c={color.text2} style={{ marginTop: 12, fontSize: 16.5, lineHeight: 24 }}>
                {p.body}
              </T>
            </Animated.View>
          </View>
        ))}
      </Animated.ScrollView>
      <Animated.View entering={FadeInUp.delay(1200).duration(600).easing(EASE)} style={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 16, gap: 14 }}>
        <Dots progress={progress} count={PAGES.length} />
        <Button
          label={last ? 'Connect your Mac' : 'Next'}
          Icon={last ? undefined : ArrowRight}
          onPress={() => {
            if (last) return onDone();
            scroll.current?.scrollTo({ x: (page + 1) * W, animated: true });
            setPage(page + 1);
          }}
        />
        <Press onPress={onDemo} style={{ alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 16 }}>
          <T v="callout" c={color.info} style={{ fontWeight: '600' }}>
            Try the demo first
          </T>
        </Press>
      </Animated.View>
    </View>
  );
}

function Back({ onPress, label = 'Back' }: { onPress: () => void; label?: string }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      <Press onPress={onPress} accessibilityLabel={label} style={{ height: 38, paddingLeft: 8, paddingRight: 14, borderRadius: 19, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.card }}>
        <ChevronLeft color={color.text} size={20} />
        <T v="callout" c={color.text} style={{ fontWeight: '500' }}>
          {label}
        </T>
      </Press>
    </View>
  );
}

function Scan({ onBack, onCode, onLink }: { onBack: () => void; onCode: () => void; onLink: (link: string) => void }) {
  const insets = useSafeAreaInsets();
  const [perm, ask] = useCameraPermissions();
  const web = Platform.OS === 'web';
  useEffect(() => {
    if (!web && perm && !perm.granted && perm.canAskAgain) void ask();
  }, [perm?.granted]);
  const live = !web && !!perm?.granted;
  return (
    <Animated.View entering={FadeIn.duration(260)} exiting={FadeOut} style={{ flex: 1, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16, paddingHorizontal: 24 }}>
      <Back onPress={onBack} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <T v="title" style={{ textAlign: 'center' }}>
          Scan your Mac's code
        </T>
        <T v="callout" style={{ textAlign: 'center' }}>
          Settings › Phone › Pair a Phone
        </T>
        <View style={{ width: 276, height: 276, marginTop: 22, borderRadius: 32, overflow: 'hidden', backgroundColor: color.sunken }}>
          {live ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                if (DEVICE_LINK.test(data)) onLink(data);
              }}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 }]}>
              <IconBadge Icon={ScanLine} tone="sky" size={56} square />
              <T v="callout" style={{ textAlign: 'center' }}>
                {web ? 'Scanning works in the phone app.' : 'Beluga needs the camera for this, and only for this.'}
              </T>
              {!web ? <Button label="Allow camera" quiet onPress={() => void ask()} style={{ height: 40 }} /> : null}
            </View>
          )}
          {live
            ? [0, 1, 2, 3].map((i) => (
                <View key={i} pointerEvents="none" style={[{ position: 'absolute', width: 34, height: 34, borderColor: color.white, borderWidth: 3, borderRadius: 12 }, i % 2 ? { right: 14, borderLeftWidth: 0 } : { left: 14, borderRightWidth: 0 }, i > 1 ? { bottom: 14, borderTopWidth: 0 } : { top: 14, borderBottomWidth: 0 }]} />
              ))
            : null}
        </View>
      </View>
      <Button label="Type the code instead" Icon={Keyboard} quiet onPress={onCode} />
    </Animated.View>
  );
}

