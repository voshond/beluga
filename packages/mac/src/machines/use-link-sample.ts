import { useSyncExternalStore } from 'react';
import type { LinkSample } from '../../../../src/machines/links.js';
import { linkSampleOf, subscribeLinks } from './link-health.js';

/** Computer `id`'s link now, for a view (link-health.ts keeps it without React, so its tests run anywhere). */
export function useLinkSample(id: string): LinkSample | undefined {
  return useSyncExternalStore(subscribeLinks, () => linkSampleOf(id));
}
