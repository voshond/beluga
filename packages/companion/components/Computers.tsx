import { router } from 'expo-router';
import { ChevronRight, Laptop, Plus } from 'lucide-react-native';
import { computerMarkIcon } from './ComputerMarkIcon';
import { View } from 'react-native';
import { when } from '../../../src/machines/words';
import { ago, useComputers, useFolded, useView } from '../lib/hooks';
import type { ComputerLinkState } from '../lib/link/computers';
import type { PhoneComputer, WorkView } from '../lib/link/protocol';
import { OnComputer } from '../lib/scope';
import { store } from '../lib/store';
import { color } from '../lib/theme';
import type { IconLike } from './AgentMark';
import { convHref, statusIcon } from './Conv';
import type { Option } from './Options';
import { Card, FoldHead, IconBadge, Press, Row, T } from './ui';

/**
 * Your computers on the phone (BLG-810): each one's mark and name, how it is in one line (as the
 * Mac's Runs on menu says it, and offline with when it was last seen), its work in Work, and the
 * rows of New Task's Runs on sheet. A computer the phone can't reach now shows greyed; its work
 * still opens, read-only, from what the phone kept.
 */

/** Its mark, as the Mac draws it: the icon kept on it, else its distribution's or its kind's (the AWS logo, a Mac mini, Ubuntu's). */
export const computerIcon = (c: Pick<PhoneComputer, 'icon' | 'kind' | 'distro' | 'platform'>): IconLike => computerMarkIcon(c);

/** The phone reaches it now (or is getting there). */
export const reachable = (s: ComputerLinkState): boolean => s.phase === 'open' || s.phase === 'dialing';

/** Can new work start there now: the phone reaches it, and the Mac said nothing stops it. */
export const takesWork = (s: ComputerLinkState): boolean => s.phase === 'open' && !s.computer.why;

/** One line: what it has free (or why it can't take work), or offline since when the phone last reached it. */
export function computerLine(s: ComputerLinkState, now = Date.now()): string {
  if (s.phase === 'open') return s.computer.why ?? s.computer.line ?? 'Connected';
  if (s.phase === 'dialing') return 'Connecting…';
  if (s.phase === 'refused') return s.detail ?? 'It turned this phone away';
  return s.lastSeen ? `Offline since ${when(s.lastSeen, now)}` : 'Offline';
}

export function ComputerMark({ s, size = 22 }: { readonly s: ComputerLinkState; readonly size?: number }) {
  return <IconBadge Icon={computerIcon(s.computer)} tone={reachable(s) ? 'sky' : 'plain'} size={size} square />;
}

/** Work's part for your computers: one folding section each, under the Mac's own projects. */
export function ComputersWork() {
  const computers = useComputers();
  if (!computers.length) return null;
  return (
    <View style={{ gap: 12 }}>
      <T v="eyebrow" style={{ paddingHorizontal: 20, marginTop: 8 }}>
        Your computers
      </T>
      {computers.map((s) => (
        <OnComputer.Provider key={s.computer.id} value={s.computer.id}>
          <ComputerSection s={s} />
        </OnComputer.Provider>
      ))}
    </View>
  );
}

/** One computer's conversations, over its own link (its `work` view), each opening there. */
function ComputerSection({ s }: { readonly s: ComputerLinkState }) {
  const fold = useFolded('work-computers');
  const work = useView<WorkView>('work');
  const id = s.computer.id;
  const live = reachable(s);
  const convs = (work?.data.projects ?? []).flatMap((p) => p.conversations.map((c) => ({ c, project: p.name })));
  return (
    <View style={{ opacity: live ? 1 : 0.55 }} accessibilityLabel={`${s.computer.name}, ${computerLine(s)}`}>
      <FoldHead folded={fold.folded(id)} onToggle={() => fold.toggle(id)} lead={<ComputerMark s={s} />} label={s.computer.name} {...(convs.length ? { count: convs.length } : {})} />
      <T v="caption" numberOfLines={1} style={{ paddingHorizontal: 20, marginTop: -2 }}>
        {computerLine(s)}
      </T>
      {fold.folded(id) ? null : (
        <Card style={{ marginHorizontal: 16, marginTop: 6 }}>
          {convs.length ? (
            convs.map(({ c, project }, i) => {
              const st = statusIcon(c.needsYou ? 'waiting' : c.status);
              return <Row key={c.topic} first={i === 0} Icon={st.Icon} tone={live ? st.tone : 'plain'} label={c.title} sub={[project, c.needsYou ? 'Needs you' : c.status === 'working' ? c.last : undefined, ago(c.lastAt)].filter(Boolean).join(' · ') || c.last} onPress={() => router.push(convHref(c.topic, id) as never)} />;
            })
          ) : (
            <Row first Icon={Plus} label={work ? 'Nothing here yet' : live ? 'Loading its work…' : 'Not reached yet'} sub={`Start work on ${s.computer.name} from New Task`} onPress={() => router.push('/ask' as never)} />
          )}
        </Card>
      )}
    </View>
  );
}

/** Runs on's rows (New Task): This Mac, then each computer with its line; one that can't take work says why instead of being picked. */
export function runsOnOptions(computers: readonly ComputerLinkState[], pick: (on: string | undefined) => void): Option[] {
  return [
    { Icon: Laptop, label: 'This Mac', sub: store.getState().phase === 'open' ? 'Your Mac, where you paired this phone' : 'Your Mac is away: it starts when it wakes', onPress: () => pick(undefined) },
    ...computers.map((s) => ({
      Icon: computerIcon(s.computer),
      label: s.computer.name,
      sub: computerLine(s),
      tone: (takesWork(s) ? 'sky' : 'plain') as Option['tone'],
      onPress: () => (takesWork(s) ? pick(s.computer.id) : store.toast({ text: `${s.computer.name} can’t take work now: ${computerLine(s)}`, tone: 'info' })),
    })),
  ];
}

/** The one row: "Runs on [icon] This Mac ›". */
export function RunsOnRow({ on, onPress }: { readonly on: ComputerLinkState | undefined; readonly onPress: () => void }) {
  const Icon = on ? computerIcon(on.computer) : Laptop;
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityLabel={`Runs on ${on?.computer.name ?? 'This Mac'}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 10, height: 40, paddingHorizontal: 12, borderRadius: 20, backgroundColor: color.sunken }}>
      <T v="caption" c={color.text2} style={{ fontWeight: '600' }}>
        Runs on
      </T>
      <Icon color={color.text} size={15} strokeWidth={1.9} />
      <T v="callout" c={color.text} numberOfLines={1} style={{ flex: 1, fontWeight: '600' }}>
        {on?.computer.name ?? 'This Mac'}
      </T>
      <ChevronRight color={color.text2} size={16} />
    </Press>
  );
}
