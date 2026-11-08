import { type ReactElement, useState } from 'react';
import type { ThreadChildren } from '@beluga/shared/threads.js';
import { Checkbox } from '../../components/Alert.js';
import { useApp } from '../../lib/beluga.js';
import { threadFamily } from '../../lib/thread-family.js';
import { count } from './pick.js';

/**
 * The one question about a chat's threads inside its archive or delete dialog. `box` is null with no
 * threads, and `children` is then undefined: the call stays as it was. Archive's default is to
 * archive them too. Delete's default is to keep them.
 */
export function useThreadsChoice(picked: string | readonly string[], action: 'archive' | 'delete'): { readonly box: ReactElement | null; readonly children?: ThreadChildren } {
  const n = useApp((st) => threadFamily(st, picked, action).count);
  const running = useApp((st) => threadFamily(st, picked, action).running);
  const [too, setToo] = useState(action === 'archive');
  if (!n) return { box: null };
  const them = `${typeof picked === 'string' || picked.length === 1 ? 'its' : 'their'} ${count(n, 'thread')}`;
  const working = running ? ` ${running} ${running === 1 ? 'is' : 'are'} working now and would stop.` : '';
  const box =
    action === 'archive' ? (
      <Checkbox checked={too} onChange={setToo} label={`Also archive ${them}`} detail={`Restoring links them again.${working} Unticked, they stay in the sidebar as chats of their own and keep working.`} />
    ) : (
      <Checkbox checked={too} onChange={setToo} label={`Also delete ${them}`} detail={`Deleting a thread loses its folder, its branch and its conversation for good.${working} Unticked, they stay in the sidebar as chats of their own and keep working.`} />
    );
  return { box, children: too ? 'with' : 'keep' };
}
