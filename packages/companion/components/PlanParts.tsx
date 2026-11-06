import { router } from 'expo-router';
import { Check, ChevronRight, FolderGit2, MessagesSquare } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { elapsed, useSince, useView } from '../lib/hooks';
import type { ConvView, PlanView, Topic } from '../lib/link/protocol';
import { color } from '../lib/theme';
import { convHref, Prose, StepTicker } from './Conv';
import { Breathe, TypingDots } from './Live';
import { Card, IconBadge, Pill, Press, T, toneBg, toneInk, toneOf } from './ui';

type Milestone = PlanView['milestones'][number];

/**
 * The plan's own conversation, on its page (the Mac keeps it beside the plan): what its Claude is
 * doing now (writing the plan, running it) or the last thing it said, and a tap into the whole chat.
 */
export function PlanChat({ topic, drafting }: { readonly topic: Topic; readonly drafting: boolean }) {
  const conv = useView<ConvView>(topic)?.data;
  const turns = conv?.turns ?? [];
  const live = [...turns].reverse().find((t) => t.who === 'claude' && t.status === 'working');
  const last = [...turns].reverse().find((t) => t.who === 'claude' && t.prose.text);
  const since = useSince(live?.ts);
  const working = Boolean(conv?.working);
  const title = drafting ? 'Writing the plan' : working ? 'Working on the plan' : 'The plan’s chat';
  return (
    <Press scaleTo={0.985} onPress={() => router.push(convHref(topic))} accessibilityLabel="Open the plan’s chat">
      <Card style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <IconBadge Icon={MessagesSquare} tone="lavender" size={30} />
          <View style={{ flex: 1 }}>
            <T v="callout" c={color.text} style={{ fontWeight: '700' }}>
              {title}
            </T>
            <T v="caption" numberOfLines={1}>
              {working ? `Your agent is at it${since !== undefined ? ` · ${elapsed(since)}` : ''}` : turns.length ? 'Tap for the whole conversation' : 'Tell your agent what to plan'}
            </T>
          </View>
          {working ? <TypingDots tone="lavender" /> : <ChevronRight color={color.text3} size={17} />}
        </View>
        {live?.step ? <StepTicker step={live.step} tone="lavender" /> : null}
        {last ? (
          <View style={{ maxHeight: 132, overflow: 'hidden' }}>
            <Prose prose={last.prose} size={14} color={color.text2} />
          </View>
        ) : null}
      </Card>
    </Press>
  );
}

/** While Claude writes the first plan: three soft milestone outlines and the one line that says so. */
export function PlanDrafting({ working }: { readonly working: boolean }) {
  return (
    <Animated.View entering={FadeIn.duration(260)} style={{ gap: 12 }}>
      <Breathe on={working}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {[3, 2, 2].map((n, i) => (
            <View key={i} style={{ flex: 1, gap: 6, padding: 10, borderRadius: 14, backgroundColor: color.sunken }}>
              <View style={{ height: 10, width: '70%', borderRadius: 5, backgroundColor: color.hairlineStrong }} />
              {Array.from({ length: n }, (_, j) => (
                <View key={j} style={{ height: 22, borderRadius: 8, backgroundColor: color.card }} />
              ))}
            </View>
          ))}
        </View>
      </Breathe>
      <T v="caption" c={color.text2} style={{ textAlign: 'center' }}>
        {working ? 'Your agent is reading the code and writing the plan. Its milestones show here as they come.' : 'Your agent isn’t writing the plan right now. Tell it what to plan in the chat.'}
      </T>
    </Animated.View>
  );
}

/**
 * How deep each milestone sits in what it waits on: the columns of the Mac's graph. A Mac before
 * 1.5 sends no `dependsOn`: its milestones run one after another.
 */
export function milestoneLevels(milestones: readonly Milestone[]): number[] {
  const index = new Map(milestones.map((m, i) => [m.id, i]));
  const memo = new Map<number, number>();
  const depth = (i: number, seen: ReadonlySet<number>): number => {
    const known = memo.get(i);
    if (known !== undefined) return known;
    const m = milestones[i]!;
    const deps = m.dependsOn === undefined ? (i > 0 ? [i - 1] : []) : m.dependsOn.map((d) => index.get(d)).filter((d): d is number => d !== undefined && !seen.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map((x) => depth(x, new Set([...seen, i])))) : 0;
    memo.set(i, d);
    return d;
  };
  return milestones.map((_, i) => depth(i, new Set([i])));
}

/** The plan as a small graph: milestones in columns by what they wait on, each with its state and progress. Tap one to open it below. */
export function MilestoneMap({ milestones, onPick }: { readonly milestones: readonly Milestone[]; readonly onPick: (id: string) => void }) {
  const levels = milestoneLevels(milestones);
  const columns: { m: Milestone; i: number }[][] = [];
  milestones.forEach((m, i) => (columns[levels[i]!] ??= []).push({ m, i }));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, alignItems: 'center' }}>
      {columns.map((col, c) => (
        <View key={c} style={{ flexDirection: 'row', alignItems: 'center' }}>
          {c ? <ChevronRight color={color.text3} size={16} style={{ marginHorizontal: 4 }} /> : null}
          <View style={{ gap: 8 }}>
            {col.map(({ m, i }) => (
              <MapNode key={m.id} m={m} i={i} onPress={() => onPick(m.id)} />
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

function MapNode({ m, i, onPress }: { readonly m: Milestone; readonly i: number; readonly onPress: () => void }) {
  const tone = toneOf(m.state);
  const done = m.tasks.filter((t) => t.state === 'done').length;
  const all = m.tasks.length;
  return (
    <Animated.View entering={FadeIn.duration(180)}>
      <Press scaleTo={0.97} onPress={onPress} accessibilityLabel={`${m.title}, ${m.state}, ${done} of ${all} tasks`}>
        <View style={{ width: 156, padding: 10, gap: 6, borderRadius: 14, backgroundColor: color.card, borderWidth: m.state === 'running' || m.state === 'gate' ? 1.5 : 0.5, borderColor: m.state === 'running' || m.state === 'gate' ? toneInk(tone) : color.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: toneBg(tone) }}>
              {m.state === 'done' ? <Check color={toneInk(tone)} size={12} strokeWidth={2.2} /> : <T v="caption" c={toneInk(tone)} style={{ fontSize: 11, fontWeight: '800' }}>{i + 1}</T>}
            </View>
            <Pill label={m.state === 'gate' ? 'for you' : m.state} tone={tone} />
          </View>
          <T v="callout" c={color.text} numberOfLines={2} style={{ fontSize: 13.5, fontWeight: '600', lineHeight: 18 }}>
            {m.title}
          </T>
          {m.repos?.length ? (
            <T v="caption" c={color.text2} numberOfLines={1} style={{ fontSize: 11 }}>
              {m.repos.join(' + ')}
            </T>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: color.sunken, overflow: 'hidden' }}>
              <View style={{ width: `${all ? (done / all) * 100 : 0}%`, height: 4, borderRadius: 2, backgroundColor: color.ok, opacity: 0.5 }} />
            </View>
            <T v="caption" style={{ fontSize: 11 }}>
              {done}/{all}
            </T>
          </View>
        </View>
      </Press>
    </Animated.View>
  );
}

/** The repos a plan across repos covers (BLG-20), primary first; nothing on a one-repo plan. */
export function PlanRepos({ repos }: { readonly repos: readonly string[] }) {
  if (repos.length < 2) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} accessibilityLabel={`Across ${repos.join(', ')}`}>
      {repos.map((r) => (
        <Pill key={r} label={r} Icon={FolderGit2} />
      ))}
    </View>
  );
}

/**
 * What was settled while planning (BLG-8): what's still open first (approving waits on it), then
 * each decision, marked You (you answered it) or Default (the agent chose it without asking).
 */
export function PlanDecisions({ decisions, open }: { readonly decisions: NonNullable<PlanView['decisions']>; readonly open: readonly string[] }) {
  if (!decisions.length && !open.length) return null;
  return (
    <View style={{ marginTop: 26, paddingHorizontal: 16, gap: 10 }}>
      <T v="eyebrow" style={{ paddingHorizontal: 4 }}>
        Decided while planning
      </T>
      <Card style={{ padding: 16, gap: 14 }}>
        {open.map((q) => (
          <View key={q} style={{ gap: 6 }}>
            <Pill label="Still open" tone="butter" style={{ alignSelf: 'flex-start' }} />
            <T v="body">{q}</T>
          </View>
        ))}
        {decisions.map((d) => (
          <View key={d.question} style={{ gap: 4 }}>
            <T v="caption" c={color.text2}>
              {d.question}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <T v="body" style={{ flexShrink: 1 }}>
                {d.answer}
              </T>
              <Pill label={d.by === 'user' ? 'You' : 'Default'} tone={d.by === 'user' ? 'lavender' : 'plain'} />
            </View>
            {d.why ? (
              <T v="caption" c={color.text3}>
                {d.why}
              </T>
            ) : null}
          </View>
        ))}
      </Card>
    </View>
  );
}
