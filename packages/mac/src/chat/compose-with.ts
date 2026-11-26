import { useEffect, useRef } from 'react';

/**
 * Something made elsewhere in the window (a graph's picture) put in the message box on screen,
 * with words after it for you to finish: nothing is sent until you send it. The box shown takes
 * it; false when there's none (no chat open).
 */

const EVENT = 'beluga:compose-with';

export type ComposeWith = { readonly files: readonly File[]; readonly words: string };

export const composeWith = (draft: ComposeWith): boolean => !document.dispatchEvent(new CustomEvent<ComposeWith>(EVENT, { detail: draft, cancelable: true }));

/** A message box takes what's handed to it while it's on screen (the first one shown, when there are several). */
export function useComposeWith(box: React.RefObject<HTMLTextAreaElement | null>, take: (draft: ComposeWith) => void): void {
  const latest = useRef(take);
  latest.current = take;
  useEffect(() => {
    const handle = (e: Event): void => {
      const el = box.current;
      if (e.defaultPrevented || !el || !el.isConnected || el.offsetParent === null) return;
      e.preventDefault();
      latest.current((e as CustomEvent<ComposeWith>).detail);
    };
    document.addEventListener(EVENT, handle);
    return () => document.removeEventListener(EVENT, handle);
  }, []);
}
