import { useEffect } from 'react';
import { keyPlatform } from './shortcuts-model.js';

export type WindowAction = 'minimize' | 'maximize' | 'close';

const inApp = (): boolean => '__TAURI_INTERNALS__' in globalThis;

const invokeApp = async (command: string, args?: Record<string, string>): Promise<void> => {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke(command, args);
};

export const ownTitleBar = (): boolean => inApp() && keyPlatform() === 'linux';

export const nativeMenuBar = (): boolean => inApp() && !ownTitleBar();

export const windowControl = (action: WindowAction): Promise<void> => invokeApp('window_control', { action });

export const useOwnTitleBar = (): void => {
  useEffect(() => {
    if (!ownTitleBar()) return;
    document.documentElement.dataset.frame = 'own';
    void invokeApp('own_title_bar').catch(() => undefined);
  }, []);
};
