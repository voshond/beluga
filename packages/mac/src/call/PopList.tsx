import { useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Avatar, cx, personColor } from '../components/ui.js';
import { type ChatPop, popMs } from './chat-pops.js';
import s from './chatpops.module.css';

/** One message, rising in and dissolving once there was time to read it (`age`: how far along it already is). */
function Pop({ pop, age }: { pop: ChatPop; age: number }) {
  // Where it was when it first showed: later updates don't start it over.
  const [startAge] = useState(age);
  return (
    <li className={s.pop} style={{ animationDuration: `${popMs(pop.text)}ms`, animationDelay: `-${startAge}ms` }}>
      <Avatar name={pop.name} id={pop.by} claude={pop.agent} size={20} />
      <span className={s.popBody}>
        <strong style={pop.agent ? undefined : { color: personColor(pop.by) }}>
          {pop.agent ? <Icon name="sparkles" size={10} /> : null}
          {pop.name}
        </strong>
        <span>{pop.text}</span>
      </span>
    </li>
  );
}

/** The messages that pop up, newest at the bottom (also the sharer's overlay, calloverlay/). */
export function PopList({ pops, now, dark, className }: { pops: readonly ChatPop[]; now: number; dark?: boolean; className?: string }) {
  if (!pops.length) return null;
  return (
    <ol className={cx(s.pops, dark && s.dark, className)} aria-live="polite" aria-label="Messages in the chat">
      {pops.map((p) => (
        <Pop key={p.id} pop={p} age={Math.max(0, now - p.at)} />
      ))}
    </ol>
  );
}
