import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Tip } from '../components/ui.js';
import { useBeluga } from '../lib/beluga.js';
import { openSettings } from '../lib/native-routes.js';
import { useClock } from '../lib/window-active.js';
import l from './learned.module.css';

const RECHECK_MS = 30_000;

/**
 * In the box you type in (BLG-102): a quiet sign that this conversation's messages go to Honcho,
 * leading to its settings. A conversation that isn't sent (Honcho off, a project left out, a chat
 * shared with someone) shows nothing.
 */
export function HonchoSign({ channel }: { channel: string }) {
  const { client, ui } = useBeluga();
  const [sends, setSends] = useState(false);
  const tick = useClock(true, RECHECK_MS);
  useEffect(() => {
    let live = true;
    client.api.honcho.sends(channel).then(
      (yes) => live && setSends(yes),
      () => live && setSends(false),
    );
    return () => {
      live = false;
    };
  }, [client, channel, tick]);
  if (!sends) return null;
  const handleOpen = (): void => openSettings(ui, 'advanced');
  return (
    <Tip label="Your messages and your agent’s answers here go to Honcho, so it learns how you work. Click for Honcho’s settings">
      <button type="button" className={l.honcho} onClick={handleOpen} aria-label="Sent to Honcho: open Honcho’s settings" data-testid="honcho-sign">
        <Icon name="eye" size={12} />
        <span className={l.honchoLabel}>Honcho</span>
      </button>
    </Tip>
  );
}
