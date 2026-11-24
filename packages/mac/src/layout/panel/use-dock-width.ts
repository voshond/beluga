import { type RefObject, useRef, useState } from 'react';
import { type ResizeHandleProps, useWindowWidth } from './ResizeHandle.js';

const WIDTH_MIN = 320;
const WIDTH_MAX = 760;
const WIDTH_STEP = 24;

export type DockWidth = {
  readonly ref: RefObject<HTMLElement | null>;
  readonly width: number;
  readonly handle: Pick<ResizeHandleProps, 'axis' | 'onMove' | 'onEnd' | 'onReset' | 'onStep'>;
};

const fitWidth = (w: number, windowWidth: number): number => Math.round(Math.max(WIDTH_MIN, Math.min(w, Math.min(WIDTH_MAX, windowWidth * 0.6))));

const readWidth = (key: string, usual: number): number => {
  try {
    const w = Number(localStorage.getItem(key));
    return Number.isFinite(w) && w > 0 ? w : usual;
  } catch {
    return usual;
  }
};

export const useDockWidth = (key: string, usual: number): DockWidth => {
  const ref = useRef<HTMLElement>(null);
  const windowWidth = useWindowWidth();
  const [width, setWidth] = useState(() => readWidth(key, usual));
  const latest = useRef(width);
  const set = (w: number): void => {
    latest.current = w;
    setWidth(w);
  };
  const keep = (w: number = latest.current): void => {
    try {
      localStorage.setItem(key, String(fitWidth(w, window.innerWidth)));
    } catch {
      return;
    }
  };
  return {
    ref,
    width: fitWidth(width, windowWidth),
    handle: {
      axis: 'x',
      onMove: (x) => {
        const r = ref.current?.getBoundingClientRect();
        if (r) set(fitWidth(r.right - x, window.innerWidth));
      },
      onEnd: () => keep(),
      onReset: () => {
        set(usual);
        keep(usual);
      },
      onStep: (dir) => {
        const w = fitWidth(latest.current + dir * WIDTH_STEP, window.innerWidth);
        set(w);
        keep(w);
      },
    },
  };
};
