import { useEffect, useRef } from 'react';

/**
 * When a view first draws what it was opened for (BLG-853): a performance mark, `name` with the
 * thing's key as its detail, in the frame after it's drawn. The remote e2e measures click to first
 * line with them (a computer's file in the reader, its diff); anyone can read them in the profiler.
 */
export function useFirstPaintMark(name: string, key: string | undefined, drawn: boolean): void {
  const marked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!drawn || !key || marked.current === key) return;
    // Kept as marked only once it is (an effect run twice in development cancels the first frame).
    const frame = requestAnimationFrame(() => {
      marked.current = key;
      performance.mark(name, { detail: key });
    });
    return () => cancelAnimationFrame(frame);
  }, [name, key, drawn]);
}
