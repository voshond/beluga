import { useState } from 'react';
import { Button } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { Group, Row, Select, Switch } from '../dialogs/settings-controls.js';
import { openNet } from './net-sheets.js';
import { errorText, quietly, useNetwork } from './use-net.js';
import { upFirst, yourComputer } from '../lib/os-words.js';

/** Settings › People & access: talking with friends directly (the Beluga network), on or off. */
export function NetworkSettings() {
  const { client, ui } = useBeluga();
  const net = useNetwork();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const turn = async (on: boolean): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await quietly(client, client.api.network.setEnabled(on));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const friends = net.friends.length;
  const groups = net.groups.filter((g) => g.active).length;
  const chatClaude = useApp((st) => st.prefs.chatClaude);
  const shareUsage = useApp((st) => st.prefs.shareUsage);
  const readReceipts = useApp((st) => st.prefs.readReceipts);
  return (
    <Group title="Friends">
      <Row
        label="Talk with friends directly"
        detail={
          error ? (
            <span style={{ color: 'var(--error)' }}>{error}</span>
          ) : busy ? (
            'Turning it on…'
          ) : net.enabled ? (
            `${upFirst(yourComputer())} connects straight to your friends’ computers, end-to-end encrypted. ${friends} friend${friends === 1 ? '' : 's'}, ${groups} channel${groups === 1 ? '' : 's'}.`
          ) : (
            'Messages, channels and files go from computer to computer, end-to-end encrypted. No server, no account.'
          )
        }
      >
        <Switch label="Talk with friends directly" on={net.enabled || busy} onChange={(v) => void turn(v)} />
      </Row>
      {net.enabled ? (
        <Row label="Add a friend" detail="Send them a code or a link; they’re your friend once they use it.">
          <Button
            onClick={() => {
              ui.patch({ settings: undefined });
              openNet({ kind: 'add_friend' });
            }}
          >
            Add a Friend…
          </Button>
        </Row>
      ) : null}
      {net.enabled ? (
        <Row label="Who can ask your agent in chats" detail="Your agent answers only messages that ask for it, on your own sign-in, from that chat’s history. You can always ask it yourself; people who aren’t your friends need your trust.">
          <Select<'everyone' | 'trusted' | 'off'>
            label="Who can ask your agent in chats"
            value={chatClaude}
            options={[
              { value: 'everyone', label: 'Friends in the chat' },
              { value: 'trusted', label: 'People I trust' },
              { value: 'off', label: 'Only me' },
            ]}
            onChange={(v) => void client.api.session.setPrefs({ chatClaude: v })}
          />
        </Row>
      ) : null}
      {net.enabled ? (
        <Row label="Who sees your usage" detail="How much of your Claude Code, Codex and other plans you have left, and when it resets, on your profile. Never your conversations or code.">
          <Select<'trusted' | 'everyone' | 'off'>
            label="Who sees your usage"
            value={shareUsage}
            options={[
              { value: 'trusted', label: 'People I trust' },
              { value: 'everyone', label: 'All my friends' },
              { value: 'off', label: 'No one' },
            ]}
            onChange={(v) => void client.api.session.setPrefs({ shareUsage: v })}
          />
        </Row>
      ) : null}
      {net.enabled ? (
        <Row label="Say when you’ve seen a message" detail="Friends see Seen under their message once it was on your screen here or on your phone. Off, they only see Delivered.">
          <Switch label="Say when you’ve seen a message" on={readReceipts} onChange={(v) => void client.api.session.setPrefs({ readReceipts: v })} />
        </Row>
      ) : null}
    </Group>
  );
}
