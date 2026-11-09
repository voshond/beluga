import { Bot, Check, CircleAlert, Clock } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { calls } from '../lib/link/calls';
import type { SubAgentDetailView, SubAgentView, Topic, TurnView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { useOn } from '../lib/scope';
import { color } from '../lib/theme';
import { Prose } from './Conv';
import { Breathe, StepList, ToolBadge, TypingDots, useAgentTime } from './Live';
import { OutputGrid } from './Outputs';
import { Sheet } from './Sheet';
import { IconBadge, Pill, Press, T, type Tone, toneBg, toneInk } from './ui';

/**
 * Claude's sub-agents on the phone (BLG-110), as the Mac shows them: in the turn where they
 * started (Live.tsx AgentList), and while any is at work a calm strip at the top of the
 * conversation, "3 agents · 2 running", one chip each with how long it has been at it. Tap one for
 * its sheet: what it's doing now, its activity in words, the report it gave back (code stripped on
 * the Mac) and what it made. Nothing bounces: chips fade in and out, the one at work breathes.
 */

export const agentTone = (s: SubAgentView['status']): Tone => (s === 'running' ? 'lavender' : s === 'failed' ? 'rose' : 'mint');
const agentIcon = (s: SubAgentView['status']) => (s === 'done' ? Check : s === 'failed' ? CircleAlert : Bot);
const agentWord = (s: SubAgentView['status']): string => (s === 'running' ? 'Working' : s === 'failed' ? 'Failed' : 'Done');

/** The agents the strip shows: the latest batch with one at work, then any other still working, in the order they started. */
export function stripAgents(turns: readonly TurnView[]): SubAgentView[] {
  const withAgents = turns.filter((t) => t.subagents?.some((a) => a.status === 'running'));
  const latest = withAgents.at(-1)?.subagents ?? [];
  const others = withAgents.slice(0, -1).flatMap((t) => (t.subagents ?? []).filter((a) => a.status === 'running'));
  return [...latest, ...others].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

function StripChip({ a, onOpen }: { readonly a: SubAgentView; readonly onOpen: (a: SubAgentView) => void }) {
  const tone = agentTone(a.status);
  const Icon = agentIcon(a.status);
  const time = useAgentTime(a);
  return (
    <Press onPress={() => onOpen(a)} scaleTo={0.98} accessibilityLabel={`${a.title}, ${agentWord(a.status)}${time ? `, ${time}` : ''}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 11, borderRadius: 16, backgroundColor: toneBg(tone) }}>
      <Breathe on={a.status === 'running'}>
        <Icon color={toneInk(tone)} size={14} strokeWidth={1.9} />
      </Breathe>
      <T v="caption" c={toneInk(tone)} numberOfLines={1} style={{ fontWeight: '600', maxWidth: 170 }}>
        {a.title}
      </T>
      {time ? (
        <T v="caption" c={toneInk(tone)} style={{ opacity: 0.75, fontVariant: ['tabular-nums'] }}>
          {time}
        </T>
      ) : null}
    </Press>
  );
}

/** "3 agents · 2 running" and a chip each, while any of the conversation's sub-agents works. */
export function AgentStrip({ turns, onOpen }: { readonly turns: readonly TurnView[]; readonly onOpen: (a: SubAgentView) => void }) {
  const agents = stripAgents(turns);
  if (!agents.length) return null;
  const running = agents.filter((a) => a.status === 'running').length;
  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(180)} style={{ paddingBottom: 8 }} accessibilityRole="summary">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 8, alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingRight: 2 }}>
          <Bot color={color.subagent} size={15} strokeWidth={1.9} />
          <T v="caption" c={color.text2} style={{ fontWeight: '600' }}>
            {agents.length} {agents.length === 1 ? 'agent' : 'agents'} · {running} running
          </T>
        </View>
        {agents.map((a) => (
          <Animated.View key={a.id} entering={FadeIn.duration(200)} exiting={FadeOut.duration(160)}>
            <StripChip a={a} onOpen={onOpen} />
          </Animated.View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

/** What a sub-agent is doing now, breathing, with how long it has been at work. */
function AgentNow({ a }: { readonly a: SubAgentView }) {
  const time = useAgentTime(a);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
      <Breathe>
        <ToolBadge kind={a.tool ?? 'agent'} size={22} />
      </Breathe>
      <T v="callout" c={color.subagent} numberOfLines={1} style={{ flex: 1, fontWeight: '600' }}>
        {a.step ?? 'Working'}
      </T>
      <TypingDots tone="lavender" />
      {time ? <T v="caption">{time}</T> : null}
    </View>
  );
}

/**
 * Its activity and report from the Mac (`companion.subAgent`, 1.10), asked again as it moves on
 * (each new view of it), a moment after: a running one's sheet follows it without a call per frame.
 */
function useAgentDetail(topic: Topic, turn: string | undefined, a: SubAgentView | undefined, open: boolean): SubAgentDetailView | undefined {
  const on = useOn();
  const [detail, setDetail] = useState<SubAgentDetailView | undefined>();
  const key = a ? `${a.id}:${a.status}:${a.count ?? 0}:${a.steps.length}:${a.step ?? ''}` : '';
  useEffect(() => {
    setDetail((d) => (d && a && d.id === a.id ? d : undefined));
  }, [a?.id]);
  useEffect(() => {
    if (!open || !a || !turn || !store.supports('subAgent')) return;
    let live = true;
    const t = setTimeout(() => {
      store.call<SubAgentDetailView>(calls.subAgent(topic, turn, a.id), { queue: false, ...(on ? { on } : {}) }).then(
        (d) => live && d && !d.missing && setDetail(d),
        () => undefined,
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, topic, turn, key]);
  return detail && a && detail.id === a.id ? detail : undefined;
}

/** One sub-agent: what it's doing, its activity, its report, what it made. */
export function SubAgentSheet({ topic, turn, agent, onClose }: { readonly topic: Topic; readonly turn?: string; readonly agent?: SubAgentView; readonly onClose: () => void }) {
  const { width } = useWindowDimensions();
  const [last, setLast] = useState<SubAgentView | undefined>(agent);
  if (agent && agent !== last) setLast(agent);
  const a = agent ?? last;
  const detail = useAgentDetail(topic, turn, a, Boolean(agent));
  const time = useAgentTime(a ?? { status: 'done' });
  const tone = agentTone(a?.status ?? 'done');
  const steps = detail?.timeline.length ? detail.timeline : (a?.trail ?? a?.steps.map((text) => ({ tool: 'tool', text })) ?? []);
  const count = detail?.count ?? a?.count ?? steps.length;
  // While it works its own row is the "now" row: the list holds what came before it.
  const before = a?.status === 'running' && a.step && steps.length ? steps.slice(0, -1) : steps;
  return (
    <Sheet
      visible={!!agent}
      onDismiss={onClose}
      header={
        a ? (
          <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <IconBadge Icon={Bot} tone="lavender" size={30} />
              <T v="callout" style={{ flex: 1 }} numberOfLines={1}>
                Sub-agent{a.type ? ` · ${a.type}` : ''}
              </T>
              <Pill label={agentWord(a.status)} tone={tone} />
            </View>
            <T v="title" style={{ fontSize: 20, lineHeight: 26 }}>
              {a.title}
            </T>
            {time || count ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {time ? <Clock color={color.text3} size={13} /> : null}
                <T v="caption">
                  {[time, count ? `${count} ${count === 1 ? 'step' : 'steps'}` : ''].filter(Boolean).join(' · ')}
                </T>
              </View>
            ) : null}
          </View>
        ) : null
      }
    >
      {a ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20, gap: 18 }}>
          {a.status === 'running' ? <AgentNow a={a} /> : null}
          {detail?.result ? (
            <Animated.View entering={FadeIn.duration(220)}>
              <T v="eyebrow" style={{ marginBottom: 10 }}>
                {a.status === 'failed' ? 'What it said' : 'Its report'}
              </T>
              <Prose prose={detail.result} size={15} />
            </Animated.View>
          ) : null}
          {before.length ? (
            <View>
              <T v="eyebrow" style={{ marginBottom: 10 }}>
                Activity
              </T>
              <StepList steps={before} shown={12} />
            </View>
          ) : a.status !== 'running' ? (
            <T v="caption">No steps it took are kept.</T>
          ) : null}
          {a.outputs.length ? (
            <View>
              <T v="eyebrow" style={{ marginBottom: 10 }}>
                Outputs · {a.outputs.length}
              </T>
              <OutputGrid items={a.outputs} cols={2} width={Math.min(width, 520) - 40} />
            </View>
          ) : null}
        </ScrollView>
      ) : null}
    </Sheet>
  );
}
