import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Graph } from '@beluga/shared/graph-spec.js';
import type { Size } from './graph-model.js';
import { cachedLayout } from './layout-cache.js';
import { PICTURE_PAD, drawPicture } from './graph-picture.js';
import g from './graph.module.css';

const FlowGraph = lazy(() => import('./FlowGraph.js'));

/** Longer than any layout takes: it failed. */
const GIVE_UP_MS = 20_000;

/** Before the graph is laid out (it wasn't, or not lately): room to measure and lay it out in. */
const ROOM: Size = { width: 1600, height: 1200 };

/**
 * The graph drawn once more, off screen, at 1:1 and whole (the card shows only what fits, a busy
 * graph only what's in view), with the layout the card has. Once drawn it's framed by what's drawn
 * and turned into a PNG.
 */
export function GraphPicture({ graph, mode, cacheKey, shapeKey, localImages, onDone, onFail }: { graph: Graph; mode: 'inline' | 'full'; cacheKey: string; shapeKey?: string; localImages: boolean; onDone: (png: Blob) => void; onFail: (err: Error) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>(() => cachedLayout(cacheKey, mode)?.bounds ?? ROOM);
  useEffect(() => {
    const timer = setTimeout(() => onFail(new Error('The graph couldn’t be laid out')), GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, []);
  // Framed by what's drawn: the frame takes its size, then the picture is taken once that shows.
  const [framed, setFramed] = useState(false);
  const handleReady = (drawn: Size): void => {
    setSize(drawn);
    setFramed(true);
  };
  useEffect(() => {
    if (!framed) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = host.current;
        if (!el) return onFail(new Error('The graph went away'));
        void drawPicture(el).then(onDone, (err: unknown) => onFail(err instanceof Error ? err : new Error(String(err))));
      }),
    );
  }, [framed]);
  return createPortal(
    <div ref={host} className={`${g.palette} ${g.pictureHost}`} style={{ width: size.width + PICTURE_PAD * 2, height: size.height + PICTURE_PAD * 2 }} aria-hidden="true">
      <Suspense fallback={null}>
        <FlowGraph graph={graph} mode={mode} localImages={localImages} cacheKey={cacheKey} {...(shapeKey ? { shapeKey } : {})} picture onLaidOut={(laid) => (framed ? undefined : setSize(laid))} onPictureReady={handleReady} />
      </Suspense>
    </div>,
    document.body,
  );
}
