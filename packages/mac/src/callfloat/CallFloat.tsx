import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { callLength } from '@beluga/shared/calls.js';
import { Icon } from '../components/Icon.js';
import { Avatar, cx } from '../components/ui.js';
import { type FloatAction, type FloatPerson, type FloatState, faceOrder } from '../call/float-model.js';
import { useClock } from '../lib/window-active.js';
import s from './callfloat.module.css';

/** Hear what the card shows (now, and as it changes), from Beluga's window through the shell. */
function useFloatState(): FloatState | null {
  const [state, setState] = useState<FloatState | null>(null);
  useEffect(() => {
    let alive = true;
    let heard = false;
    let off: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<FloatState | null>('call-float', (e) => {
          heard = true;
          setState(e.payload);
        }),
      )
      .then(async (un) => {
        if (!alive) return un();
        off = un;
        const { invoke } = await import('@tauri-apps/api/core');
        const now = await invoke<FloatState | null>('call_float_state');
        if (alive && !heard) setState(now);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return state;
}

const invokeShell = (cmd: string, args?: Record<string, unknown>): void =>
  void import('@tauri-apps/api/core').then(({ invoke }) => invoke(cmd, args)).catch(() => undefined);

const act = (action: FloatAction, conversation: string): void => invokeShell('call_float_action', { action, conversation });

/** See-through room on each side of the card for its shadow (callfloat.module.css keeps the same). */
const ROOM_X = 16;
/** Moving this far (px) with the button down drags the card; less is a click. */
const DRAG_PX = 4;
/** Coming up, the card shows everything this long before it shrinks to faces. */
const INTRO_MS = 2_600;
/** The pointer leaves it: it waits this long, then shrinks. */
const LINGER_MS = 700;
/** How long growing or shrinking takes (the card's transition in callfloat.module.css). */
const RESIZE_MS = 420;
/** How often the card asks where the pointer is (its window is never the key one: nobody tells it). */
const POINTER_POLL_MS = 120;

/**
 * Whether the pointer is over the card. Its window never becomes the key window, so macOS doesn't
 * always tell it the mouse came in: it asks the shell where the pointer is, a few times a second,
 * while it shows (a pointer event, when one comes, answers sooner).
 */
function useHovered(card: HTMLDivElement | null): boolean {
  const [over, setOver] = useState(false);
  // The card's window is never the one you're in, so this clock always runs while it shows.
  const beat = useClock(card !== null, POINTER_POLL_MS);
  useEffect(() => {
    if (!card) return;
    const enter = (): void => setOver(true);
    card.addEventListener('pointerenter', enter);
    return () => card.removeEventListener('pointerenter', enter);
  }, [card]);
  useEffect(() => {
    if (!card) return;
    let alive = true;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<[number, number] | null>('call_float_pointer'))
      .then((at) => {
        if (!alive) return;
        const r = card.getBoundingClientRect();
        setOver(Boolean(at && at[0] >= r.left && at[0] <= r.right && at[1] >= r.top && at[1] <= r.bottom));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [card, beat]);
  return over;
}

/**
 * Open (everything) or compact (faces): open as it comes up, then compact by itself; open again
 * while the pointer is on it, and a moment after it leaves.
 */
function useOpen(shown: boolean, hovered: boolean): boolean {
  const [until, setUntil] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (shown) setUntil(Date.now() + INTRO_MS);
  }, [shown]);
  useEffect(() => {
    if (!hovered) setUntil((u) => Math.max(u, Date.now() + LINGER_MS));
  }, [hovered]);
  useEffect(() => {
    const left = until - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), left + 10);
    return () => clearTimeout(t);
  }, [until]);
  return hovered || Date.now() < until;
}

/** How wide a face of the card is (its words, measured as they change). */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const say = (): void => setW(Math.ceil(el.getBoundingClientRect().width));
    say();
    const ro = new ResizeObserver(say);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}

/**
 * The card's window fits the card: growing, the window makes room first; shrinking, the window
 * follows once the card is done, so the card moves smoothly inside it and the see-through window
 * never sits wider than the card over the app under it.
 */
function useWindowFit(open: boolean, full: number, compact: number): void {
  const [wide, setWide] = useState(open);
  useEffect(() => {
    if (open) return setWide(true);
    const t = setTimeout(() => setWide(false), RESIZE_MS + 40);
    return () => clearTimeout(t);
  }, [open]);
  const width = (wide ? Math.max(full, compact) : compact) + ROOM_X * 2;
  useEffect(() => {
    if (full && compact) invokeShell('call_float_resize', { width });
  }, [width, full, compact]);
}

/** How long a face takes to slide to its new place when someone else starts talking. */
const SLIDE_MS = 380;

/** The faces' order: whoever talks comes to the front and stays there until someone else talks (call/float-model.ts). */
function useFaceOrder(people: readonly FloatPerson[]): readonly FloatPerson[] {
  const last = useRef<readonly string[]>([]);
  const order = faceOrder(last.current, people);
  last.current = order;
  const byId = new Map(people.map((p) => [p.peerId, p]));
  return order.map((id) => byId.get(id)!);
}

/**
 * A stack of faces, the front one on top, a ring on whoever talks. When the order changes, each
 * face slides from where it was to where it is now, so someone starting to talk glides to the front.
 */
function Faces({ people, size, more }: { people: readonly FloatPerson[]; size: number; more: number }) {
  const row = useRef<HTMLSpanElement>(null);
  const was = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const now = new Map<string, number>();
    for (const face of el.querySelectorAll<HTMLElement>('[data-face]')) {
      const id = face.dataset['face'] ?? '';
      const x = face.offsetLeft;
      now.set(id, x);
      const before = was.current.get(id);
      if (!still && before !== undefined && before !== x) {
        face.animate([{ transform: `translateX(${before - x}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
      }
    }
    was.current = now;
  });
  return (
    <span ref={row} className={s.faces}>
      {people.map((p, i) => (
        <span key={p.peerId} data-face={p.peerId} className={cx(s.face, p.speaking && s.speaking)} style={{ zIndex: people.length - i }}>
          <Avatar name={p.name} id={p.peerId} size={size} />
        </span>
      ))}
      {more > 0 ? <span className={s.more}>+{more}</span> : null}
    </span>
  );
}

/** Drag from anywhere but its buttons (its middle, which opens the call, drags too). A drag isn't a click. */
function useDrag(): { onPointerDown: (e: ReactPointerEvent) => void; dragged: () => boolean } {
  const moved = useRef(false);
  const onPointerDown = (e: ReactPointerEvent): void => {
    moved.current = false;
    if (e.button !== 0) return;
    const button = (e.target as HTMLElement).closest('button');
    if (button && !button.dataset['drag']) return;
    const x = e.clientX;
    const y = e.clientY;
    const move = (m: PointerEvent): void => {
      if (Math.hypot(m.clientX - x, m.clientY - y) < DRAG_PX) return;
      moved.current = true;
      stop();
      invokeShell('call_float_drag');
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };
  return { onPointerDown, dragged: () => moved.current };
}

/**
 * The call while Beluga is behind other apps (BLG-706, BLG-743). It comes up showing everything,
 * then shrinks to a small pill of faces (whoever talks glides to the front with a ring that
 * breathes; a dot while you share; muted, the whole card turns rose and shows a crossed microphone); point at it and it grows back with its buttons: stop sharing,
 * mute, leave, hide. Drag it anywhere: it comes back there. A click on its middle goes back to the
 * call in Beluga. Ringing, it stays whole: who calls, decline and join.
 */
export function CallFloat() {
  const state = useFloatState();
  // The card's window is never the one you're in: its clock always runs (watchWindow isn't started here).
  const now = useClock(true);
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const hovered = useHovered(card);
  const ringing = state?.kind === 'ringing';
  const open = useOpen(state !== null, hovered) || ringing;
  const [fullRef, fullW] = useWidth();
  const [compactRef, compactW] = useWidth();
  const pill = ringing ? fullW : compactW;
  useWindowFit(open, fullW, pill);
  const { onPointerDown, dragged } = useDrag();
  const ordered = useFaceOrder(state?.kind === 'in' ? state.people : []);
  if (!state) return null;
  const openCall = (): void => {
    if (!dragged()) act('open', state.conversation);
  };
  // Until both faces are measured, nothing shows (no jump on the first frame).
  const size: CSSProperties = fullW && pill ? { width: open ? fullW : pill } : { visibility: 'hidden' };
  const tab = open ? 0 : -1;

  if (state.kind === 'ringing') {
    return (
      <div ref={setCard} className={cx(s.card, s.open, s.ringing)} style={size} onPointerDown={onPointerDown}>
        <div ref={fullRef} className={s.full}>
          <button type="button" className={s.main} data-drag="true" onClick={openCall}>
            <span className={s.face}>
              <Avatar name={state.by.name} id={state.by.peerId} size={30} />
            </span>
            <span className={s.text}>
              <strong>{state.by.name} is calling</strong>
              <span>{state.group ? state.place : 'Voice call'}</span>
            </span>
          </button>
          <button type="button" className={s.decline} aria-label="Decline" onClick={() => act('decline', state.conversation)}>
            <Icon name="callEnd" size={16} />
          </button>
          <button type="button" className={s.join} aria-label="Join" onClick={() => act('join', state.conversation)}>
            <Icon name="call" size={15} />
          </button>
        </div>
      </div>
    );
  }

  const talking = state.people.find((p) => p.speaking);
  const status = state.youShare ? null : talking ? `${talking.name} is talking` : state.sharing ? `${state.sharing} is sharing` : state.people.length ? callLength(now - state.startedAt) : 'Ringing…';
  const faces = ordered.slice(0, 3);
  const more = state.people.length - faces.length;
  return (
    <div ref={setCard} className={cx(s.card, open && s.open, state.youShare && s.sharing, state.muted && s.muted)} style={size} onPointerDown={onPointerDown}>
      <div ref={fullRef} className={s.full} aria-hidden={!open}>
        <button type="button" className={s.main} data-drag="true" tabIndex={tab} onClick={openCall}>
          <Faces people={faces} size={26} more={0} />
          <span className={s.text}>
            <strong>{state.place}</strong>
            {status !== null ? (
              <span>{status}</span>
            ) : (
              // You're sharing: the card says so for as long as it lasts, whoever talks.
              <span className={s.onShow}>
                <span className={s.liveDot} aria-hidden="true" />
                Sharing your screen
              </span>
            )}
          </span>
        </button>
        {state.youShare ? (
          <button type="button" className={s.stop} aria-label="Stop Sharing" tabIndex={tab} onClick={() => act('stop-sharing', state.conversation)}>
            <Icon name="screenShare" size={13} />
            Stop
          </button>
        ) : null}
        <button type="button" className={cx(s.round, state.muted && s.off)} aria-label={state.muted ? 'Unmute' : 'Mute'} tabIndex={tab} onClick={() => act(state.muted ? 'unmute' : 'mute', state.conversation)}>
          <Icon name={state.muted ? 'micOff' : 'mic'} size={15} />
        </button>
        <button type="button" className={s.decline} aria-label="Leave Call" tabIndex={tab} onClick={() => act('leave', state.conversation)}>
          <Icon name="callEnd" size={16} />
        </button>
        {/* Out of the way until you're back in Beluga (the frame around a shared screen stays). */}
        <button type="button" className={s.tuck} aria-label="Hide" title="Hide until you’re back in Beluga" tabIndex={tab} onClick={() => act('hide', state.conversation)}>
          <Icon name="chevronUp" size={13} />
        </button>
      </div>
      {/* Compact: who's there and who's talking, and whether you share or are muted. */}
      <div ref={compactRef} className={s.compact} aria-hidden={open}>
        {state.youShare ? <span className={s.liveDot} aria-label="Sharing your screen" /> : null}
        {faces.length ? (
          <Faces people={faces} size={22} more={more} />
        ) : (
          <span className={s.waiting} aria-label="Ringing">
            <Icon name="call" size={13} />
          </span>
        )}
        {state.muted ? (
          <span className={s.mutedMark} aria-label="Muted">
            <Icon name="micOff" size={12} />
          </span>
        ) : null}
      </div>
    </div>
  );
}
