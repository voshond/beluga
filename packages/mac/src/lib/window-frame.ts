import { useEffect } from 'react';
import { appInvoke, inShell, native } from './boot-mode.js';
import { keyPlatform } from './shortcuts-model.js';

export type WindowAction = 'minimize' | 'maximize' | 'close';

export const ownTitleBar = (): boolean => inShell() && keyPlatform() === 'linux';

export const nativeMenuBar = (): boolean => native('appMenu') && !ownTitleBar();

export const windowControl = (action: WindowAction): Promise<void> => appInvoke('window_control', { action });

export const useOwnTitleBar = (): void => {
  useEffect(() => {
    if (!ownTitleBar()) return;
    document.documentElement.dataset.frame = 'own';
    void appInvoke('own_title_bar').catch(() => undefined);
  }, []);
};
