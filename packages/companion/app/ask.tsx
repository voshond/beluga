import { Image } from 'expo-image';
import { ProjectMark } from '../components/ProjectMark';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowUp, ChevronDown, Folder, GitBranch, ImagePlus, Laptop, ListChecks, MessageCircleQuestion, MessageSquare, Mic, Sparkles, Square, Workflow, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { AgentChoice, type PickedAgent } from '../components/AgentChoice';
import { RunsOnRow, runsOnOptions } from '../components/Computers';
import { convHref } from '../components/Conv';
import { Options } from '../components/Options';
import { Sheet } from '../components/Sheet';
import { Avatar, haptic, IconBadge, Press, T, type Tone, toneBg, toneInk } from '../components/ui';
import { agentPicksSupported } from '../lib/agent-picks';
import { useComputers, useView, useViewAt } from '../lib/hooks';
import { kv } from '../lib/kv';
import { type Call, calls } from '../lib/link/calls';
import { type HomeView, type PeopleView, type Topic, type WorkView, isMacTopic } from '../lib/link/protocol';
import { pickPhoto, upload } from '../lib/pick';
import { sends } from '../lib/sends';
import { store } from '../lib/store';
import { appendSpoken } from '../lib/dictate';
import { color, spring } from '../lib/theme';
import { useVoice, voiceAvailable } from '../lib/voice';
import { VoiceButton, VoiceNote, VoiceStage, voiceActive } from '../components/Voice';

/**
 * The Ask button's sheet: write, (attach a photo), send. Where it goes is one pill: tap it to
 * pick Your Mac (first, and the default: your Claude for the whole Mac), a project, an open
 * conversation, or a friend's Claude. The answer comes back into that conversation, which opens.
 *
 * In a project (1.5) it's what the Mac's project home offers, as three icon chips: a new worktree
 * with Claude on your words (the default; Plan first beside it is Claude Code's plan mode: it
 * proposes a plan before it acts), an Advanced plan (Beluga's Plans: milestones, tasks and what
 * waits on what, drafted for you to approve, then run on the board), or a question (read-only).
 *
 * The microphone beside Send writes down what you say while you say it (lib/voice.ts): each pause
 * is written down at once. ■ puts the words in the field to edit; ↑ sends them as you said them.
 *
 * With computers of yours (BLG-810), one row says where it runs, "Runs on This Mac ›", and its
 * sheet lists them with how each is: picking one lists its projects and starts the work there,
 * over that computer's own link, whether or not your Mac answers.
 */
type Target = { kind: 'mac'; topic: Topic; label: string } | { kind: 'project'; id: string; label: string; icon?: string; empty?: boolean } | { kind: 'conv'; topic: Topic; label: string; project?: string; icon?: string } | { kind: 'friend'; id: string; name: string; label: string };
const ICON: Record<Target['kind'], { Icon: typeof Folder; tone: Tone }> = { mac: { Icon: Laptop, tone: 'sky' }, project: { Icon: Folder, tone: 'butter' }, conv: { Icon: MessageSquare, tone: 'sky' }, friend: { Icon: Sparkles, tone: 'lavender' } };
const ASSISTANT: Topic = 'conv:mac:assistant';

/** How a project takes your words (BLG-69). */
type Mode = 'worktree' | 'plan' | 'question';
const MODES: ReadonlyArray<{ mode: Mode; label: string; Icon: typeof Folder; tone: Tone; hint: string }> = [
  { mode: 'worktree', label: 'Worktree', Icon: GitBranch, tone: 'mint', hint: 'Fix the login redirect and add a test' },
  { mode: 'plan', label: 'Advanced plan', Icon: Workflow, tone: 'butter', hint: 'Add sign-in with passkeys: milestones and tasks to approve' },
  { mode: 'question', label: 'Question', Icon: MessageCircleQuestion, tone: 'sky', hint: 'How does the payment flow work?' },
];

export default function Ask() {
  const params = useLocalSearchParams<{ friend?: string; topic?: string; text?: string; to?: string; how?: string }>();
  // A start that didn't go gives its words back (and where they were going): from its screen, or left for here.
  const [back] = useState(() => (params.text !== undefined ? { text: params.text, target: params.to, how: params.how } : sends.draft));
  const [visible, setVisible] = useState(true);
  // Runs on (BLG-810): This Mac (none) or one of your computers, the last pick kept while it's still yours.
  const computers = useComputers();
  const [runsOn, setRunsOn] = useState<string | undefined>(() => kv.get<string>('runs-on') || undefined);
  const [choosing, setChoosing] = useState(false);
  const onComputer = computers.find((c) => c.computer.id === runsOn);
  const on = onComputer?.computer.id;
  const can = (what: Parameters<typeof store.supports>[0]): boolean => (on ? store.supportsOn(on, what) : store.supports(what));
  const work = useViewAt<WorkView>(on, 'work');
  const home = useViewAt<HomeView>(on, 'home');
  const people = useView<PeopleView>('people');
  const [text, setText] = useState(back?.text ?? '');
  useEffect(() => void (sends.draft = undefined), []);
  const [photo, setPhoto] = useState<{ name: string; mime: string; b64: string; uri: string } | undefined>();
  const [picking, setPicking] = useState(false);
  const [mode, setMode] = useState<Mode>(() => MODES.find((m) => m.mode === back?.how)?.mode ?? 'worktree');
  const [planFirst, setPlanFirst] = useState(false);
  // Who works a new worktree (BLG-506) or an advanced plan's milestones and tasks (BLG-498): none is your default agent.
  const [agent, setAgent] = useState<PickedAgent | undefined>();
  // Sent only to a Mac that takes it (SINCE.workAgents); an older one starts with your default.
  const picked = agent && (on ? can('workAgents') : agentPicksSupported()) ? agent : undefined;
  // An older Mac (before 1.5) has neither Your Mac nor worktrees and plans from here.
  const modes = can('askModes');
  // Speaking (BLG-161): ■ puts the words in the box to edit; ↑ sends them as you said them, once written down.
  const said = useRef<(words: string) => void>(() => {});
  const voice = useVoice({ text: (words) => setText((t) => appendSpoken(t, words)), send: (words) => said.current(words) });
  const speaking = voice.view.phase === 'listening' || voice.view.phase === 'writing';

  const targets = useMemo<Target[]>(() => {
    const t: Target[] = [];
    // Your Mac: the chat open on the Mac (it has tabs since BLG-102); its other chats working now are below, by their names.
    const mac = home?.data.assistant?.topic && isMacTopic(home.data.assistant.topic) ? home.data.assistant.topic : ASSISTANT;
    if (can('assistant')) t.push({ kind: 'mac', topic: mac, label: home?.data.assistant?.title?.split(' · ')[0] || (onComputer?.computer.name ?? 'Your Mac') });
    // Only your own projects take a new chat: not the room, a friend's shared project or "Asked of
    // friends" (views.ts groups those under 'room', 'shared:…' and 'asked').
    for (const p of work?.data.projects ?? []) if (p.id !== 'room' && p.id !== 'asked' && !p.id.startsWith('shared:')) t.push({ kind: 'project', id: p.id, label: p.name, ...(p.icon ? { icon: p.icon } : {}), ...(p.conversations.length ? {} : { empty: true }) });
    for (const c of home?.data.running ?? []) if (c.topic !== mac) t.push({ kind: 'conv', topic: c.topic, label: c.title, ...(c.project ? { project: c.project } : {}), ...(c.icon ? { icon: c.icon } : {}) });
    // Friends are asked from your Mac (with it closed, from your Always On: BLG-850).
    if (!on) for (const p of people?.data.people ?? []) if (p.presence !== 'offline') t.push({ kind: 'friend', id: p.peerId, name: p.name, label: `${p.name}'s agent` });
    return t;
  }, [work, home, people, on]);
  const [sel, setSel] = useState<string | undefined>();
  const keyOf = (t: Target): string => (t.kind === 'conv' || t.kind === 'mac' ? t.topic : `${t.kind}:${t.id}`);
  useEffect(() => {
    // Wait for the list the default comes from (projects, unless aimed at a friend or a conversation).
    if (sel || !targets.length || (!params.friend && !params.topic && !work)) return;
    const again = back?.target ? targets.find((t) => keyOf(t) === back.target) : undefined;
    const want =
      again ??
      (params.friend
        ? targets.find((t) => t.kind === 'friend' && t.id === params.friend)
        : params.topic
          ? targets.find((t) => (t.kind === 'conv' || t.kind === 'mac') && t.topic === params.topic)
          : (targets.find((t) => t.kind === 'mac') ?? targets.find((t) => t.kind === 'project')));
    setSel(keyOf(want ?? targets[0]!));
  }, [targets]);
  const target = targets.find((t) => keyOf(t) === sel);
  /** What a project does with your words: a worktree, a plan, a question (only a question before 1.5). */
  const how: Mode = target?.kind === 'project' && modes ? mode : 'question';
  // Photos go with a question, a message or (1.12) a new worktree; a plan starts from your words.
  // A photo goes up through your Mac's link only (not yet to a computer's).
  const photos = !on && target?.kind !== 'friend' && !(target?.kind === 'project' && (how === 'plan' || (how === 'worktree' && !store.supports('worktreePhotos'))));

  const close = () => {
    setVisible(false);
    setTimeout(() => (router.canGoBack() ? router.back() : router.replace('/')), 230);
  };

  const send = (spoken?: string) => {
    const words = (spoken !== undefined ? appendSpoken(text, spoken) : text).trim();
    if (!words || !target) return;
    haptic.commit();
    const pic = photo && photos ? photo : undefined;
    // The photo goes first (`put`), then the message names it: both after the sheet has closed.
    const make = (c: (files: string[]) => Call): Call | (() => Promise<Call>) => (pic ? async () => c([await upload(pic)]) : c([]));
    const opts = { ...(pic ? { photo: true } : {}), ...(on ? { on } : {}) };
    // Shown at once, confirmed by the Mac (lib/sends.ts): a message in its conversation, a start on its own screen.
    let href: string;
    if (target.kind === 'conv' || target.kind === 'mac') {
      sends.message(target.topic, words, make((files) => calls.send(target.topic, words, files)), opts);
      href = convHref(target.topic, on);
    } else {
      const kind = target.kind === 'friend' ? 'friend' : how;
      const call =
        target.kind === 'friend'
          ? make(() => calls.askPerson(target.id, target.name, words))
          : how === 'worktree'
            ? make((files) => (files.length ? calls.startWorktreeWith(target.id, words, planFirst, files, picked) : calls.startWorktree(target.id, words, planFirst, picked)))
            : how === 'plan'
              ? make(() => planCall(target.id, words, agent))
              : make((files) => calls.ask(target.id, words, files));
      const id = sends.start({ kind, label: target.label, target: keyOf(target), ...(target.kind === 'project' ? { project: target.label, ...(target.icon ? { icon: target.icon } : {}) } : {}), ...(kind === 'worktree' && planFirst ? { plan: true } : {}) }, words, call, opts);
      href = `/starting/${id}`;
    }
    setVisible(false);
    setTimeout(() => {
      (router.canGoBack() ? router.back() : router.replace('/'));
      setTimeout(() => router.push(href as never), 60);
    }, 200);
  };

  said.current = (words) => send(words);

  const mark = (t: Target, size: number) => (t.kind === 'friend' ? <Avatar name={t.name} size={size} /> : t.kind === 'project' ? <ProjectMark name={t.label} icon={t.icon} size={size} /> : t.kind === 'conv' && t.project ? <ProjectMark name={t.project} icon={t.icon} size={size} /> : <IconBadge Icon={ICON[t.kind].Icon} tone={ICON[t.kind].tone} size={size} />);
  const groups: { title: string; kind: Target['kind'] }[] = [
    // Your Mac is its own row, first: no heading over it.
    { title: '', kind: 'mac' },
    { title: 'New in a project', kind: 'project' },
    { title: 'Add to a conversation', kind: 'conv' },
    { title: "A friend's agent", kind: 'friend' },
  ];

  return (
    <>
      <Sheet visible={visible} onDismiss={close}>
        <View style={{ paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <T v="title" numberOfLines={1} style={{ flex: 1, fontSize: 22 }}>
            {onComputer ? `Ask ${onComputer.computer.name}` : 'Ask your Mac'}
          </T>
          <Press onPress={close} accessibilityLabel="Close" hitSlop={10} style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
            <X color={color.text2} size={17} />
          </Press>
        </View>

        {picking ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
            <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}>
              {groups.map((g) => {
                const list = targets.filter((t) => t.kind === g.kind);
                if (!list.length) return null;
                return (
                  <View key={g.kind} style={{ marginTop: 8 }}>
                    {g.title ? (
                      <T v="eyebrow" style={{ paddingHorizontal: 10, marginBottom: 4 }}>
                        {g.title}
                      </T>
                    ) : null}
                    {list.map((t) => (
                      <Press
                        key={keyOf(t)}
                        scaleTo={0.98}
                        onPress={() => {
                          setSel(keyOf(t));
                          setPicking(false);
                        }}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 14, backgroundColor: keyOf(t) === sel ? color.sunken : 'transparent' }}
                      >
                        {mark(t, 32)}
                        <View style={{ flex: 1 }}>
                          <T v="body" numberOfLines={1}>
                            {t.label}
                          </T>
                          {t.kind === 'project' && t.empty ? (
                            <T v="caption" numberOfLines={1}>
                              No conversations yet
                            </T>
                          ) : null}
                        </View>
                      </Press>
                    ))}
                  </View>
                );
              })}
            </ScrollView>
          </Animated.View>
        ) : (
          <View>
            <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
              {voiceActive(voice.view) ? (
                // While it records, the stage is the field: the blob, and the words landing where they'll stay.
                <VoiceStage voice={voice} before={text} minHeight={92} />
              ) : (
                <TextInput
                  autoFocus
                  value={text}
                  onChangeText={setText}
                  multiline
                  placeholder={target?.kind === 'friend' ? `What should ${target.name}'s agent do?` : target?.kind === 'project' && modes ? MODES.find((m) => m.mode === how)!.hint : target?.kind === 'mac' ? 'Take a screenshot and send it to me' : 'Run the tests and send me a screenshot'}
                  placeholderTextColor={color.text3}
                  style={{ color: color.text, fontSize: 19, lineHeight: 26, minHeight: 92, maxHeight: 200, textAlignVertical: 'top', ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
                />
              )}
              {photo ? (
                <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(150)} style={{ width: 80, height: 80, borderRadius: 16, overflow: 'hidden', marginTop: 6 }}>
                  <Image source={{ uri: photo.uri }} style={{ flex: 1 }} contentFit="cover" />
                  <Press onPress={() => setPhoto(undefined)} accessibilityLabel="Remove photo" style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: color.card }}>
                    <X color={color.text2} size={13} />
                  </Press>
                </Animated.View>
              ) : null}
              <VoiceNote voice={voice} />
            </View>
            {target?.kind === 'project' && modes ? <ModeChips mode={mode} onMode={setMode} planFirst={planFirst} onPlanFirst={setPlanFirst} agent={agent} onAgent={setAgent} /> : null}
            {computers.length ? <RunsOnRow on={onComputer} onPress={() => setChoosing(true)} /> : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 10 }}>
              <Press onPress={() => setPicking(true)} accessibilityLabel="Where it goes" style={{ flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingLeft: 6, paddingRight: 12, borderRadius: 22, backgroundColor: color.sunken }}>
                {target ? mark(target, 32) : null}
                <T v="callout" c={color.text} numberOfLines={1} style={{ fontWeight: '600', flexShrink: 1 }}>
                  {target?.label ?? 'Where'}
                </T>
                <ChevronDown color={color.text2} size={16} />
              </Press>
              {!photos ? null : (
              <Press onPress={async () => setPhoto((await pickPhoto().catch(() => undefined)) ?? photo)} accessibilityLabel="Add a photo" style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sunken }}>
                <ImagePlus color={color.text2} size={20} />
              </Press>
              )}
              <View style={{ flex: 1 }} />
              {voiceAvailable() ? (
                <VoiceButton
                  voice={voice}
                  onPress={() => {
                    const p = voice.view.phase;
                    if (p === 'off') return void (haptic.tap(), voice.start());
                    haptic.commit();
                    if (p === 'listening') voice.finish('edit');
                    else voice.cancel();
                  }}
                />
              ) : null}
              <Press
                disabled={!text.trim() && !speaking}
                onPress={() => (speaking ? (haptic.commit(), voice.finish('send')) : send())}
                accessibilityLabel={speaking ? 'Send it as you said it' : 'Send'}
                style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: text.trim() || speaking ? color.primary : color.sunken }}
              >
                <ArrowUp color={text.trim() || speaking ? color.onPrimary : color.text3} size={22} strokeWidth={2} />
              </Press>
            </View>
          </View>
        )}
      </Sheet>
      <Options
        window
        visible={choosing}
        onClose={() => setChoosing(false)}
        title="Runs on"
        options={runsOnOptions(computers, (id) => {
          setRunsOn(id);
          kv.set('runs-on', id ?? '');
          // Where it goes is that computer's now: its projects, its assistant.
          setSel(undefined);
        })}
      />
    </>
  );
}

/** A new plan, with who works it when picked (plans.create takes `agent` from 1.34; an older Mac, just the goal). */
function planCall(project: string, goal: string, agent: PickedAgent | undefined): Call {
  const c = calls.createPlan(project, goal) as Call<'plans.create'>;
  if (!agent || !agentPicksSupported()) return c as unknown as Call;
  return { ...c, args: [{ ...c.args[0], agent }] } as Call<'plans.create'> as unknown as Call;
}

/**
 * A project's three ways in, as icon chips (as the Mac's project home offers them), and Plan first beside a worktree's (wrapping on a narrow phone, so the send row keeps only where it goes, a photo, the mic and send).
 * Who works a new worktree (BLG-506) or an advanced plan (BLG-498) sits beside them the same way: Your agent unless you pick another.
 */
function ModeChips({ mode, onMode, planFirst, onPlanFirst, agent, onAgent }: { readonly mode: Mode; readonly onMode: (m: Mode) => void; readonly planFirst: boolean; readonly onPlanFirst: (on: boolean) => void; readonly agent: PickedAgent | undefined; readonly onAgent: (a: PickedAgent | undefined) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 10 }}>
      {MODES.map((m) => {
        const on = m.mode === mode;
        return (
          <Press
            key={m.mode}
            onPress={() => (haptic.tap(), onMode(m.mode))}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={m.label}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 10, borderRadius: 17, backgroundColor: on ? toneBg(m.tone) : color.sunken }}
          >
            <m.Icon color={on ? toneInk(m.tone) : color.text2} size={15} strokeWidth={1.9} />
            <T v="caption" c={on ? toneInk(m.tone) : color.text2} style={{ fontWeight: '700' }}>
              {m.label}
            </T>
          </Press>
        );
      })}
      {mode === 'worktree' ? <PlanFirst on={planFirst} onChange={onPlanFirst} /> : null}
      {mode !== 'question' && agentPicksSupported() ? <AgentChoice value={agent} onChange={onAgent} /> : null}
    </View>
  );
}

/** Plan mode for a new worktree: its Claude plans first and asks you to approve (the Mac's Plan chip). */
function PlanFirst({ on, onChange }: { readonly on: boolean; readonly onChange: (on: boolean) => void }) {
  return (
    <Press
      onPress={() => (haptic.tap(), onChange(!on))}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel="Plan mode: the agent plans first"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 10, borderRadius: 17, backgroundColor: on ? toneBg('lavender') : color.sunken }}
    >
      <ListChecks color={on ? toneInk('lavender') : color.text2} size={15} strokeWidth={1.9} />
      <T v="caption" c={on ? toneInk('lavender') : color.text2} style={{ fontWeight: '700' }}>
        Plan first
      </T>
    </Press>
  );
}
