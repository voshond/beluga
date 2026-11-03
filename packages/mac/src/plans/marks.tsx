import type { Actor } from '@beluga/core/board/model.js';
import type { PlanPr } from '@beluga/core/plans/model.js';
import type { TaskState } from '@beluga/core/plans/progress.js';
import { useRef } from 'react';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, cx } from '../components/ui.js';
import { openExternal } from '../lib/system.js';
import { useApp } from '../lib/beluga.js';
import { agentName, useMyAgent } from '../lib/agent-words.js';
import { breath, turn, useLive } from '../lib/live-motion.js';
import { type Need, type Signal, signalOf } from '../layout/attention-model.js';
import { SignalMark } from '../layout/signal-marks.js';
import { type Headline, type Tone, type Who, TASK_STATE, prWords } from './plans-model.js';
import p from './plans.module.css';

/** Small marks shared by the plan's graph, outline and lists: a task's state, a tone pill, progress. */

export function TaskStateIcon({ state, size = 14 }: { state: TaskState; size?: number }) {
  const tone = TASK_STATE[state].tone;
  const c = 8;
  const r = 5.6;
  const icon = useRef<SVGSVGElement>(null);
  // Running: the ring turns with the live clock (lib/live-motion.ts), not a CSS animation.
  useLive(icon, (t) => icon.current?.style.setProperty('--turn', `${turn(t, 1100)}deg`), state === 'running');
  return (
    <svg ref={icon} width={size} height={size} viewBox="0 0 16 16" className={cx(p.stateIcon, p[`tone_${tone}`], state === 'running' && p.spinning)} aria-hidden="true">
      {state === 'done' ? (
        <>
          <circle cx={c} cy={c} r={6.5} className={p.iconFill} />
          <path d="M5.2 8.2l1.9 1.9 3.8-4.1" className={p.iconMark} />
        </>
      ) : state === 'canceled' || state === 'missing' ? (
        <>
          <circle cx={c} cy={c} r={6.5} className={p.iconFill} />
          <path d="M5.8 5.8l4.4 4.4 M10.2 5.8l-4.4 4.4" className={p.iconMark} />
        </>
      ) : state === 'blocked' ? (
        <>
          <rect x={4.5} y={7.2} width={7} height={5.3} rx={1.2} className={p.iconFill} />
          <path d="M6 7.2V5.6a2 2 0 0 1 4 0v1.6" className={p.iconRing} />
        </>
      ) : state === 'asking' || state === 'stalled' ? (
        <>
          <circle cx={c} cy={c} r={6.5} className={p.iconFill} />
          <path d="M8 4.8v4 M8 11.1v.01" className={p.iconMark} />
        </>
      ) : state === 'running' ? (
        <>
          <circle cx={c} cy={c} r={r} className={p.iconTrack} />
          <path d={`M${c} ${c - r}a${r} ${r} 0 0 1 ${r} ${r}`} className={p.iconRing} />
          <circle cx={c} cy={c} r={2} className={p.iconFill} />
        </>
      ) : state === 'review' || state === 'idle' ? (
        <>
          <circle cx={c} cy={c} r={r} className={p.iconRing} />
          <path d={state === 'review' ? `M${c} ${c}V${c - 3.6}A3.6 3.6 0 1 1 ${c - 3.6} ${c}z` : `M${c} ${c}V${c - 3.6}A3.6 3.6 0 0 1 ${c} ${c + 3.6}z`} className={p.iconFill} />
        </>
      ) : state === 'ready' ? (
        <>
          <circle cx={c} cy={c} r={r} className={p.iconRing} />
          <circle cx={c} cy={c} r={2.2} className={p.iconFill} />
        </>
      ) : (
        <circle cx={c} cy={c} r={r} className={cx(p.iconRing, p.dashed)} />
      )}
    </svg>
  );
}

export function TonePill({ tone, children, live }: { tone: Tone; children: React.ReactNode; live?: boolean }) {
  return (
    <span className={cx(p.pill, p[`tone_${tone}`])}>
      {live ? <LiveDot /> : <span className={p.pillDot} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** A dot that breathes while Claude works (with the live clock, lib/live-motion.ts). */
export function LiveDot() {
  const dot = useRef<HTMLSpanElement>(null);
  useLive(dot, (t) => dot.current?.style.setProperty('--breath', breath(t, 1600).toFixed(3)));
  return <span ref={dot} className={cx(p.pillDot, p.pillLive)} aria-hidden="true" />;
}

/** A plan's milestones as a row of segments, each filled as far as it got. */
export function MilestoneBar({ items }: { items: ReadonlyArray<{ readonly id: string; readonly title: string; readonly state: string; readonly share: number }> }) {
  return (
    <span className={p.bar} role="img" aria-label={items.map((m) => `${m.title}: ${Math.round(m.share * 100)}%`).join(', ')}>
      {items.map((m) => (
        <span key={m.id} className={cx(p.barSegment, p[`seg_${m.state}`])} title={m.title}>
          <span className={p.barFill} style={{ width: `${Math.round(m.share * 100)}%` }} />
        </span>
      ))}
    </span>
  );
}

type Bar = { readonly id: string; readonly title: string; readonly state: string; readonly share: number };

/**
 * A plan's one progress bar: a column per row of milestones, left to right in the order they
 * run; milestones that run side by side share a column, stacked as thin parallel tracks.
 */
export function PlanProgress({ columns }: { columns: ReadonlyArray<readonly Bar[]> }) {
  const all = columns.flat();
  return (
    <span className={p.progress} role="img" aria-label={all.map((m) => `${m.title}: ${Math.round(m.share * 100)}%`).join(', ')}>
      {columns.map((col) => (
        <span key={col.map((m) => m.id).join()} className={p.progressCol} data-parallel={col.length > 1 ? col.length : undefined}>
          {col.map((m) => (
            <span key={m.id} className={cx(p.barSegment, p[`seg_${m.state}`])} title={m.title}>
              <span className={p.barFill} style={{ width: `${Math.round(m.share * 100)}%` }} />
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

/** Whose turn a sentence is: your initial, your agent's mark, or Beluga's (the plan itself). */
function WhoMark({ who, size = 20 }: { who: Who; size?: number }) {
  const id = useApp((s) => s.selfId);
  const name = useApp((s) => s.self?.name ?? s.network.self?.name ?? 'You');
  const agent = useMyAgent();
  if (who === 'you') return <Avatar name={name} id={id} size={size} />;
  if (who === 'claude') return <Avatar name={agentName(agent)} id={id} agent={agent} size={size} />;
  return (
    <span className={p.belugaMark} style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="claude" size={Math.round(size * 0.55)} />
    </span>
  );
}

/** An actor as a mark (for the feed). */
export function ActorMark({ by, size = 18 }: { by: Actor; size?: number }) {
  const selfId = useApp((s) => s.selfId);
  const mine = useMyAgent();
  if (by.kind === 'person') return <Avatar name={by.name} id={by.id} size={size} />;
  // The agent the board recorded (BLG-498); an older entry: yours, your agent's mark; someone else's, the Claude mark.
  if (by.kind === 'claude') return <Avatar name={by.ownerName} id={by.owner} claude agent={by.agent ?? (by.owner === selfId ? mine : undefined)} size={size} />;
  return <WhoMark who="beluga" size={size} />;
}

/** The plan's sentence: who, then what (“You: pass “API” — Claude checked all 4 criteria”). */
export function Said({ line, className }: { line: Headline; className?: string }) {
  return (
    <span className={cx(p.said, className)} data-who={line.who}>
      <WhoMark who={line.who} />
      <span className={p.saidText}>
        {line.who === 'you' ? <strong className={p.saidYou}>You: </strong> : null}
        {line.who === 'you' ? line.text.charAt(0).toLowerCase() + line.text.slice(1) : line.text}
      </span>
    </span>
  );
}

/** A padlock, shut (a milestone waits on gates not passed yet) or open (they passed). */
export function LockMark({ open = false, size = 12 }: { open?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x={3.5} y={7} width={9} height={6.5} rx={1.6} fill="currentColor" stroke="none" />
      <path d={open ? 'M5.5 7V5a2.5 2.5 0 0 1 4.9-.7' : 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'} />
    </svg>
  );
}

/**
 * A task's chat, as the sidebar would mark it (a plan keeps its tasks off the sidebar): a dot when
 * its Claude waits on you, else how many new messages. Nothing when there's nothing new.
 */
export function TaskChatMark({ worktree }: { worktree?: string }) {
  // A plain string, so the graph and the outline only redraw when the mark changes.
  const mark = useApp((st) => {
    if (!worktree) return '';
    const x = signalOf(st, `ws:${worktree}`, worktree);
    return x.level === 'needs' ? `needs|${x.need ?? ''}|${x.tip}` : x.unread ? `unread|${x.unread}|${x.tip}` : '';
  });
  if (!mark) return null;
  const [level, value, tip] = mark.split('|') as [string, string, string];
  const signal: Signal = level === 'needs' ? { level: 'needs', unread: 0, working: false, tip, ...(value ? { need: value as Need } : {}) } : { level: 'unread', unread: Number(value), working: false, tip };
  return (
    <span className={p.taskChatMark} title={tip} data-task-chat={level}>
      <SignalMark signal={signal} />
    </span>
  );
}

/** The plan's pull request, one click from GitHub, with what stands in its way (the page's header, and above its conversation). */
export function PlanPrChip({ pr }: { pr: PlanPr }) {
  return (
    <Button size="small" variant="quiet" icon="pr" title={`#${pr.number} ${pr.title}: ${prWords(pr)}. Open on GitHub`} onClick={() => void openExternal(pr.url)} className={p.prChip} data-state={pr.state === 'OPEN' ? (pr.conflicts || pr.checks === 'failing' ? 'problem' : 'open') : pr.state.toLowerCase()}>
      #{pr.number} · {pr.state === 'OPEN' ? prWords(pr) : pr.state === 'MERGED' ? 'Merged' : 'Closed'}
    </Button>
  );
}
