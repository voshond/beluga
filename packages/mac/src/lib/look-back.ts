import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { lookBackWords } from '@beluga/shared/memory.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { toast } from './beluga.js';

/**
 * Look Back (BLG-96, BLG-108): propose what to remember from what was said in a conversation of yours
 * since the last look back at it. Any time, as often as you like, with the setting on or off (it only
 * switches the look back at a merge). /lookback in the message box does the same.
 */

/** Look back at it now, and say what came of it. */
export const lookBack = (client: SocketClient, channel: string): void => {
  client.api.memory.reflect(channel).then(
    (outcome) => toast(client, lookBackWords(outcome), 'info'),
    (err: unknown) => toast(client, err instanceof Error ? err.message : 'Cannot look back at this conversation', 'error'),
  );
};

export const lookBackItem = (client: SocketClient, channel: string): ActionItem => ({ label: 'Look Back', icon: 'sparkles', onSelect: () => lookBack(client, channel) });
