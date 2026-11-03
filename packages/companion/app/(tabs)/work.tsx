import { router, useLocalSearchParams } from 'expo-router';
import { Folder, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentDots, convHref, statusIcon } from '../../components/Conv';
import { PlansList } from '../../components/Plans';
import { Header, Screen, useScrolled } from '../../components/Screen';
import { Segments } from '../../components/Segments';
import { Card, FoldHead, Row } from '../../components/ui';
import { ago, useFolded, useSupports, useView } from '../../lib/hooks';
import type { PlansView, TasksView, WorkView } from '../../lib/link/protocol';
import { store } from '../../lib/store';
import { ProjectMark } from '../../components/ProjectMark';
import { TasksList } from '../../components/Tasks';
import { color, TAB_BAR_H } from '../../lib/theme';

/** Work: projects and their conversations (each project folds, remembered); plans and tasks beside them. */
export default function Work() {
  const { scrolled, onScroll } = useScrolled();
  const fold = useFolded('work');
  const insets = useSafeAreaInsets();
  const work = useView<WorkView>('work');
  const plans = useView<PlansView>('plans');
  const { tab: wanted } = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<'convs' | 'plans' | 'tasks'>(wanted === 'tasks' || wanted === 'plans' ? wanted : 'convs');
  const runningPlans = plans?.data.plans.filter((p) => p.state === 'running').length ?? 0;
  const tasks = useView<TasksView>(useSupports('tasks') ? 'tasks' : undefined);
  const inReview = tasks?.data.projects.reduce((n, p) => n + (p.groups.find((g) => g.status === 'in_review')?.tasks.length ?? 0), 0) ?? 0;

  return (
    <Screen>
      <Header scrolled={scrolled} title="Work" at={work?.at} />
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Segments
          value={tab}
          onChange={setTab}
          options={[
            { key: 'convs', label: 'Conversations' },
            { key: 'plans', label: 'Plans', badge: runningPlans },
            { key: 'tasks', label: 'Tasks', badge: inReview },
          ]}
        />
      </View>
      <ScrollView onScroll={onScroll} scrollEventThrottle={32} contentContainerStyle={{ paddingTop: 8, paddingBottom: TAB_BAR_H + insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        {tab === 'plans' ? (
          <Animated.View entering={FadeIn}>
            <PlansList />
          </Animated.View>
        ) : tab === 'tasks' ? (
          <Animated.View entering={FadeIn}>
            <TasksList />
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn} style={{ gap: 12 }}>
            {(work?.data.projects ?? []).map((p) => (
              <View key={p.id}>
                <FoldHead
                  folded={fold.folded(p.id)}
                  onToggle={() => fold.toggle(p.id)}
                  lead={p.id === 'asked' || p.id === 'room' ? <Folder color={color.text3} size={18} /> : <ProjectMark name={p.name} icon={p.icon} size={22} />}
                  label={p.name}
                  {...(p.conversations.length ? { count: p.conversations.length } : {})}
                />
                {fold.folded(p.id) ? null : (
                <Card style={{ marginHorizontal: 16, marginTop: 6 }}>
                  {p.conversations.length ? null : (
                    // A project with nothing in it yet (just added): one tap to start its first worktree.
                    <Row
                      first
                      Icon={Plus}
                      label="No conversations yet"
                      sub="Start the first one here"
                      onPress={() => router.push({ pathname: '/ask', params: { text: '', to: `project:${p.id}`, how: 'worktree' } })}
                    />
                  )}
                  {p.conversations.map((c, i) => {
                    const st = statusIcon(c.needsYou ? 'waiting' : c.status);
                    return (
                      <Row
                        key={c.topic}
                        first={i === 0}
                        Icon={st.Icon}
                        tone={st.tone}
                        label={c.title}
                        sub={[c.needsYou ? 'Needs you' : c.status === 'working' ? c.last : undefined, c.fresh ? `${c.fresh} new ${c.fresh === 1 ? 'output' : 'outputs'}` : undefined, ago(c.lastAt)].filter(Boolean).join(' · ') || c.last}
                        right={c.agents ? <AgentDots count={c.agents} /> : c.unread ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color.info }} /> : null}
                        onPress={() => router.push(convHref(c.topic))}
                      />
                    );
                  })}
                </Card>
                )}
              </View>
            ))}
          </Animated.View>
        )}
      </ScrollView>
    </Screen>
  );
}
