import { router } from 'expo-router';
import { Bot, CornerLeftUp, Network, Square } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { THREAD_WORDS } from '../../../src/shared/threads';
import { calls } from '../lib/link/calls';
import { familyRows, familyRunning } from '../lib/thread-rows';
import type { ThreadFamilyView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import { AgentMarkIcon, agentMark } from './AgentMark';
import { convHref } from './Conv';
import { Sheet } from './Sheet';
import { Button, haptic, IconBadge, Press, T, type Tone, toneInk } from './ui';

/**
 * A chat's family (1.44), the Mac's Threads panel: the chat that started it, the threads it started,
 * how each is doing and Stop on the ones at work. Stopping one stops those under it too. A thread's
 * work stays in its own conversation, a tap away. Its native sub-agents (SINCE.threadAgents) share the
 * list, read-only: a quiet "sub-agent" word, no Stop and no page (their work is on the conversation's strip).
 */

const STATE_TONE: Record<string, Tone> = { queued: 'plain', running: 'peach', needs_you: 'butter', done: 'mint', failed: 'rose', stopped: 'plain', interrupted: 'butter' };

const wordOf = (state: string): string => (THREAD_WORDS as Readonly<Record<string, string>>)[state] ?? state;

/** The sheet's row in the conversation's ••• sheet. */
export function threadsSummary(threadFamily: ThreadFamilyView | undefined): string {
  if (!threadFamily) return '';
  const working = familyRunning(threadFamily);
  const threads = threadFamily.children.length;
  const agents = threadFamily.agents?.length ?? 0;
  return [threadFamily.parent ? `Started by ${threadFamily.parent.title}` : '', threads ? `${threads} ${threads === 1 ? 'thread' : 'threads'}` : '', agents ? `${agents} ${agents === 1 ? 'sub-agent' : 'sub-agents'}` : '', working ? `${working} running` : ''].filter(Boolean).join(' · ');
}

export function ThreadsSheet({ threadFamily, visible, onClose }: { readonly threadFamily: ThreadFamilyView | undefined; readonly visible: boolean; readonly onClose: () => void }) {
  const open = (topic: Parameters<typeof convHref>[0]): void => {
    onClose();
    router.push(convHref(topic));
  };
  const stop = (call: ReturnType<typeof calls.stopThread>): void => {
    haptic.commit();
    void store.call(call, { queue: false }).catch((e: Error) => store.toast({ text: e.message, tone: 'error' }));
  };
  const running = threadFamily ? familyRunning(threadFamily) : 0;
  const parent = threadFamily?.parent;
  return (
    <Sheet
      visible={visible && Boolean(threadFamily)}
      onDismiss={onClose}
      header={
        <View style={{ paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <IconBadge Icon={Network} tone="lavender" size={32} />
          <T v="title" style={{ flex: 1, fontSize: 20 }}>
            {running ? `Threads · ${running} running` : 'Threads'}
          </T>
        </View>
      }
    >
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 2 }}>
        {parent ? (
          <Press
            disabled={!parent.topic}
            scaleTo={0.99}
            onPress={() => (parent.topic ? open(parent.topic) : undefined)}
            accessibilityLabel={parent.topic ? `Open the parent chat, ${parent.title}` : parent.title}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 8 }}
          >
            <CornerLeftUp color={color.text3} size={18} />
            <View style={{ flex: 1 }}>
              <T v="body" numberOfLines={1} style={{ fontWeight: '500' }}>
                {parent.title}
              </T>
              <T v="caption">{['Started by this chat', parent.gone ? 'Removed' : parent.state ? wordOf(parent.state) : parent.topic ? 'Idle' : ''].filter(Boolean).join(' · ')}</T>
            </View>
          </Press>
        ) : null}
        {(threadFamily ? familyRows(threadFamily) : []).map((c) => {
          const tone = STATE_TONE[c.state] ?? 'plain';
          const topic = c.topic;
          return (
            <View key={`${c.kind}:${c.id}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Press
                disabled={!topic}
                scaleTo={0.99}
                onPress={() => (topic ? open(topic) : undefined)}
                accessibilityLabel={topic ? `Open ${c.title}, ${wordOf(c.state)}` : `Sub-agent ${c.title}, ${wordOf(c.state)}`}
                style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 8 }}
              >
                {threadFamily?.marks === false ? <Bot color={color.text3} size={18} /> : <AgentMarkIcon mark={agentMark(c.harness)} size={18} color={color.text3} muted />}
                <View style={{ flex: 1 }}>
                  <T v="body" numberOfLines={1} style={{ fontWeight: '500' }}>
                    {c.title}
                  </T>
                  <T v="caption" numberOfLines={1}>
                    {c.kind === 'agent' ? 'sub-agent · ' : ''}
                    {c.harness.label} ·{' '}
                    <T v="caption" c={toneInk(tone)}>
                      {wordOf(c.state)}
                    </T>
                  </T>
                </View>
              </Press>
              {c.kind === 'thread' && c.working ? (
                <Press onPress={() => stop(calls.stopThread(c.id))} hitSlop={6} accessibilityLabel={`Stop ${c.title}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, paddingHorizontal: 12, marginRight: 8, borderRadius: 16, backgroundColor: color.sunken }}>
                  <Square color={color.text2} size={12} />
                  <T v="caption" c={color.text2} style={{ fontWeight: '700' }}>
                    Stop
                  </T>
                </Press>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      {(threadFamily?.stoppable.length ?? 0) > 1 ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 6 }}>
          <Button label="Stop all running" Icon={Square} quiet onPress={() => stop(calls.stopThreads(threadFamily!.chat))} />
        </View>
      ) : null}
    </Sheet>
  );
}
