import { useCallback, useEffect, useState } from 'react';
import { inApp } from './boot.js';
import { useClock } from './window-active.js';
import type { PrivacyAccess, PrivacyPane } from './privacy-model.js';

/**
 * The macOS permissions the welcome offers (src-tauri/src/privacy.rs): whether Beluga has each,
 * and the way to it. In a browser (developing, end-to-end tests) there's no shell: a test seeds
 * `window.__BELUGA_PRIVACY__` before the page loads, and what the buttons ask for is recorded in
 * `window.__BELUGA_PRIVACY_CALLS__`.
 */


export type { Grant, PrivacyAccess, PrivacyPane } from './privacy-model.js';

export const UNKNOWN_PRIVACY: PrivacyAccess = { screen: 'unknown', accessibility: 'unknown', disk: 'unknown', automation: 'unknown' };

declare global {
  interface Window {
    __BELUGA_PRIVACY__?: Partial<PrivacyAccess>;
    __BELUGA_PRIVACY_CALLS__?: string[];
  }
}

export async function privacyAccess(): Promise<PrivacyAccess> {
  if (!inApp()) return { ...UNKNOWN_PRIVACY, ...(typeof window !== 'undefined' ? window.__BELUGA_PRIVACY__ : undefined) };
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<PrivacyAccess>('privacy_access').catch(() => UNKNOWN_PRIVACY);
}

/** Put Beluga in the pane's list where macOS allows it, and open System Settings there. */
export async function requestPrivacy(pane: PrivacyPane): Promise<void> {
  if (!inApp()) {
    (window.__BELUGA_PRIVACY_CALLS__ ??= []).push(pane);
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('privacy_request', { pane });
}

/**
 * What macOS says now, checked again whenever the window comes back (you've likely just been in
 * System Settings) and every few seconds while you look at it (System Settings can sit beside it).
 */
export function usePrivacyAccess(active = true): { readonly access: PrivacyAccess | undefined; readonly recheck: () => void } {
  const [access, setAccess] = useState<PrivacyAccess>();
  const recheck = useCallback((): void => void privacyAccess().then(setAccess), []);
  // Ticks while the window is in front, and once more as it comes back (it rests while you look away).
  const now = useClock(active, 2500);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void privacyAccess().then((a) => live && setAccess(a));
    return () => {
      live = false;
    };
  }, [active, now]);
  return { access, recheck };
}
