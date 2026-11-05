import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { CallPersonView } from '@beluga/shared/calls.js';
import { Avatar, personColor } from '../components/ui.js';
import { type Glide, aim, glideAlpha, step } from './glide.js';
import { POINTER_PATH } from './ink.js';
import { useCallEngine } from './use-call.js';
import c from './call.module.css';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Everyone else's pointer over a shared screen (BLG-733), for those who chose to show it (Show My
 * Pointer, off until they turn it on): an arrow in their colour, their picture and name beside it,
 * gliding where they point. Pointers come many times a second and each one
 * follows its last spot on a spring (call/glide.ts), so it moves smoothly however the network
 * delivers. Positions are written straight to the page on each frame, not through React: a
 * pointer moving never draws the stage again. Yours isn't here: it's your own mouse.
 */
export function Pointers({ people, me, box }: { people: readonly CallPersonView[]; me: string; box: Box }) {
  const engine = useCallEngine();
  const [who, setWho] = useState<readonly string[]>([]);
  const glides = useRef(new Map<string, Glide>());
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const boxRef = useRef(box);
  boxRef.current = box;

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const place = (el: HTMLDivElement, g: Glide, alpha: number): void => {
      const b = boxRef.current;
      el.style.transform = `translate3d(${b.x + g.x * b.w}px, ${b.y + g.y * b.h}px, 0)`;
      el.style.opacity = String(alpha);
    };
    const frame = (t: number): void => {
      const dt = last ? (t - last) / 1000 : 0;
      last = t;
      const gone: string[] = [];
      for (const [by, g] of glides.current) {
        const next = step(g, dt);
        glides.current.set(by, next);
        const alpha = glideAlpha(next, t);
        if (alpha <= 0) gone.push(by);
        const el = nodes.current.get(by);
        if (el) place(el, next, alpha);
      }
      if (gone.length) {
        for (const by of gone) glides.current.delete(by);
        setWho((w) => w.filter((x) => !gone.includes(x)));
      }
      raf = glides.current.size ? requestAnimationFrame(frame) : 0;
    };
    const run = (): void => {
      if (raf) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const off = engine.onStage((m) => {
      if (m.k !== 'laser' || m.by === me) return;
      if (m.x < 0) {
        glides.current.delete(m.by);
        setWho((w) => w.filter((x) => x !== m.by));
        return;
      }
      const was = glides.current.get(m.by);
      glides.current.set(m.by, aim(was, m.x, m.y, performance.now()));
      if (!was) setWho((w) => (w.includes(m.by) ? w : [...w, m.by]));
      run();
    });
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [engine, me]);

  if (!who.length) return null;
  return (
    <div className={c.pointers} aria-hidden="true">
      {who.map((by) => {
        const person = people.find((p) => p.peerId === by);
        const name = person?.name ?? 'Someone';
        const g = glides.current.get(by);
        const style: CSSProperties = g ? { transform: `translate3d(${box.x + g.x * box.w}px, ${box.y + g.y * box.h}px, 0)` } : { opacity: 0 };
        return (
          <PointerMark
            key={by}
            by={by}
            name={name}
            style={style}
            nodeRef={(el) => {
              if (el) nodes.current.set(by, el);
              else nodes.current.delete(by);
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * One person's pointer: an arrow in their colour, their picture and name beside it. The same mark
 * on every screen: the others see yours gliding, and you see it right under your own mouse.
 */
export function PointerMark({ by, name, style, nodeRef }: { by: string; name: string; style?: CSSProperties; nodeRef?: (el: HTMLDivElement | null) => void }) {
  const color = personColor(by);
  return (
    <div className={c.pointer} style={style} ref={nodeRef}>
      <svg className={c.pointerArrow} viewBox="0 0 16 21" width={16} height={21}>
        <path d={POINTER_PATH} fill={color} stroke="#ffffff" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
      <span className={c.pointerTag} style={{ background: color }}>
        <Avatar name={name} id={by} size={16} />
        <span>{name}</span>
      </span>
    </div>
  );
}
