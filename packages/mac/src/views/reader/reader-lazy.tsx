import { lazy, useState } from 'react';
import { chunk } from '../../lib/chunks-model.js';
import type { FileContentProps } from './FileReader.js';

/**
 * The reader in its own chunk, loaded the first time a file opens or as soon as one is read ahead
 * (streamed.ts, BLG-853). Once it's loaded it draws at once: a plain React.lazy would still show
 * Opening… for a moment on its first draw, even with the code already here. It loads through the
 * app's chunk loader (lib/chunks-model.ts, #370): fetched early while the window is idle, and a
 * fetch that stalls gives up (the ViewBoundary around it offers Reload) instead of waiting for good.
 */

const reader = chunk('views/reader/FileReader', () => import('./FileReader.js'), { prefetch: 'first' });

let loaded: typeof import('./FileReader.js') | undefined;

/** Load the reader's code (once). */
export const loadReader = (): Promise<typeof import('./FileReader.js')> =>
  reader.load().then((m) => {
    loaded = m;
    return m;
  });

const Lazy = lazy(() => loadReader().then((m) => ({ default: m.FileContent })));

/** FileContent, drawn directly when its code is here (decided once per mount, so it never remounts). */
export function ReaderContent(props: FileContentProps) {
  const [ready] = useState(() => loaded);
  return ready ? <ready.FileContent {...props} /> : <Lazy {...props} />;
}
