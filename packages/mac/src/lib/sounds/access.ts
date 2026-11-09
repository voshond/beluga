import { useCallback, useEffect, useState } from 'react';
import { inApp } from '../boot.js';
import { type AccessAction, type NotificationAccess, UNKNOWN_ACCESS } from './access-model.js';

export type { NotificationAccess } from './access-model.js';

/**
 * Asking the app shell (src-tauri/src/sounds.rs) what macOS allows. In a browser (developing,
 * end-to-end tests) there's no shell: a test seeds `window.__BELUGA_NOTIFY_ACCESS__` before the
 * page loads, and what the buttons ask for is recorded in `window.__BELUGA_NOTIFY_CALLS__`.
 */
declare global {
  interface Window {
    __BELUGA_NOTIFY_ACCESS__?: NotificationAccess;
    __BELUGA_NOTIFY_CALLS__?: string[];
  }
}

async function shell<T>(cmd: string, fallback: T): Promise<T> {
  if (!inApp()) {
    (window.__BELUGA_NOTIFY_CALLS__ ??= []).push(cmd);
    return fallback;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd);
}

const browserAccess = (): NotificationAccess => (typeof window !== 'undefined' && window.__BELUGA_NOTIFY_ACCESS__) || UNKNOWN_ACCESS;

/** What macOS says now (`unknown` outside the app: a browser's permission isn't macOS's). */
export async function notificationAccess(): Promise<NotificationAccess> {
  if (!inApp()) return browserAccess();
  return shell<NotificationAccess>('notification_access', UNKNOWN_ACCESS).catch(() => UNKNOWN_ACCESS);
}

/**
 * Ask macOS to let Beluga send notifications (its prompt shows the first time; after that it's
 * System Settings). The on-screen pop-up needs no permission; notifications are what reach you
 * when the pop-up is off, and in Notification Center later. Resolves with what macOS says now.
 */
export async function askNotificationPermission(): Promise<NotificationAccess> {
  if (!inApp()) {
    (window.__BELUGA_NOTIFY_CALLS__ ??= []).push('request_permission');
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission().catch(() => undefined);
    return browserAccess();
  }
  const { requestPermission } = await import('@tauri-apps/plugin-notification');
  await requestPermission().catch(() => undefined);
  return notificationAccess();
}

/** Open System Settings › Notifications, at Beluga. */
export async function openNotificationSettings(): Promise<void> {
  await shell('open_notification_settings', undefined);
}

/** Open System Settings › Focus. */
export async function openFocusSettings(): Promise<void> {
  await shell('open_focus_settings', undefined);
}

/** Do what a guide's button says; resolves with the access afterwards. */
export async function runAccessAction(action: AccessAction): Promise<NotificationAccess | undefined> {
  await (action === 'focus' ? openFocusSettings() : openNotificationSettings());
  return undefined;
}

/**
 * The current access, checked again whenever the window comes back (you may have just changed
 * it in System Settings), and on `recheck` (after a test).
 */
export function useNotificationAccess(): { readonly access: NotificationAccess | undefined; readonly recheck: (known?: NotificationAccess) => void } {
  const [access, setAccess] = useState<NotificationAccess>();
  const recheck = useCallback((known?: NotificationAccess): void => {
    if (known) setAccess(known);
    else void notificationAccess().then(setAccess);
  }, []);
  useEffect(() => {
    let live = true;
    const check = (): void => void notificationAccess().then((a) => live && setAccess(a));
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') check();
    };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return { access, recheck };
}
