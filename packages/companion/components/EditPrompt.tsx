import { GitBranch, Undo2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { calls } from '../lib/link/calls';
import type { TurnView } from '../lib/link/protocol';
import { store } from '../lib/store';
import { useOn } from '../lib/scope';
import { color } from '../lib/theme';
import { convHref } from './Conv';
import { Segments } from './Segments';
import { Sheet } from './Sheet';
import { Button, haptic, T } from './ui';

type Mode = 'here' | 'fork';

/** The choice made last time, so the next edit starts there (as on the Mac). */
let lastMode: Mode = 'here';

/**
 * A message you sent, opened to edit (BLG-387, the Mac's BLG-385): its words, then where the edit
 * goes. Rewind Here: the conversation goes back to just before it (what came after goes, Claude
 * forgets it, a worktree's files are as they were then). New Fork: a new worktree or chat from that
 * point, opened here; this one stays as it is.
 */
export function EditPromptSheet({ turn, onClose }: { readonly turn: TurnView | undefined; readonly onClose: () => void }) {
  const on = useOn();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>(lastMode);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!turn) return;
    setText(turn.prose.text);
    setMode(lastMode);
  }, [turn?.id]);
  const edit = turn?.edit;
  const worktree = edit?.kind === 'worktree';
  const send = async (): Promise<void> => {
    if (!turn || !edit || busy || !text.trim()) return;
    lastMode = mode;
    haptic.commit();
    setBusy(true);
    try {
      const went = await store.call<string>(calls.editPrompt(edit.ws, turn.id, text, mode), { queue: false, ...(on ? { on } : {}) });
      onClose();
      // A fork opens where it went on.
      if (mode === 'fork' && went && went !== `ws:${edit.ws}`) router.replace(convHref(went) as never);
    } catch (e) {
      store.toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const note =
    mode === 'here'
      ? worktree
        ? 'What came after this goes, and the files go back to how they were then.'
        : 'What came after this goes, and your agent forgets it.'
      : worktree
        ? 'Goes on in a new worktree from this point. This one stays as it is.'
        : 'Goes on in a new chat from this point. This one stays as it is.';
  return (
    <Sheet
      visible={Boolean(turn)}
      onDismiss={onClose}
      header={
        <View style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
          <T v="title" style={{ fontSize: 20 }}>
            Edit your message
          </T>
        </View>
      }
    >
      <View style={{ paddingHorizontal: 20, paddingBottom: 20, gap: 14 }}>
        <TextInput
          autoFocus
          value={text}
          onChangeText={setText}
          multiline
          editable={!busy}
          accessibilityLabel="Edit your message"
          placeholderTextColor={color.text3}
          style={{ color: color.text, fontSize: 17, lineHeight: 24, minHeight: 72, maxHeight: 220, textAlignVertical: 'top', padding: 12, borderRadius: 14, backgroundColor: color.sunken, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) }}
        />
        <Segments<Mode>
          value={mode}
          onChange={(m) => (haptic.tap(), setMode(m))}
          options={[
            { key: 'here', label: 'Rewind Here', Icon: Undo2 },
            { key: 'fork', label: 'New Fork', Icon: GitBranch },
          ]}
        />
        <T v="caption">{note}</T>
        <Button label={busy ? (mode === 'here' ? 'Rewinding…' : 'Forking…') : mode === 'here' ? 'Rewind and Send' : 'Fork and Send'} Icon={mode === 'here' ? Undo2 : GitBranch} disabled={busy || !text.trim()} onPress={() => void send()} />
      </View>
    </Sheet>
  );
}
