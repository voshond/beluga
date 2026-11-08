import { Icon } from '../components/Icon.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { sameFields } from '../lib/stable.js';
import { type ThreadStart, mixedHarnesses, startedBy } from './threads-model.js';
import s from './threads.module.css';

/** The top of a child's chat: who started it. It opens the parent; a removed parent keeps its title and opens nothing. */
export function StartedByLine({ channel }: { channel: string }) {
  const actions = useActions();
  const parent = useApp((st) => startedBy(st, channel), (a, b) => a === b || Boolean(a && b && sameFields(a, b)));
  if (!parent) return null;
  return (
    <div className={s.startedBy} data-started-by="">
      <Icon name="up" size={11} />
      <span>Started by </span>
      {parent.openId ? (
        <button type="button" className={s.link} onClick={() => actions.run({ type: 'open_ws', id: parent.openId! })}>
          {parent.title}
        </button>
      ) : (
        <span className={s.gone}>{parent.title}</span>
      )}
    </div>
  );
}

/** In a parent's chat: the thread it started, in one line, with a way to it. */
export function ThreadStartLine({ thread }: { thread: ThreadStart }) {
  const actions = useActions();
  const mixed = useApp(mixedHarnesses);
  return (
    <div className={s.startLine} data-thread-start={thread.id}>
      <span title={thread.agent}>{mixed ? <Icon name={thread.mark} size={12} fill="currentColor" /> : <Icon name="bot" size={12} />}</span>
      <span>Started thread </span>
      {thread.archived ? (
        <span className={s.gone}>{thread.title}</span>
      ) : (
        <button type="button" className={s.link} onClick={() => actions.run({ type: 'open_ws', id: thread.id })}>
          {thread.title}
        </button>
      )}
    </div>
  );
}
