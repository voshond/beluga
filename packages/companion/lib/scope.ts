import { createContext, useContext } from 'react';

/**
 * Which of your computers a screen shows (BLG-810): none for your Mac, else that computer's id.
 * A conversation opened from a computer's list is wrapped in it, so its views, what it can do and
 * its calls go over that computer's own link (lib/hooks.ts reads it; calls take it as `on`).
 */
export const OnComputer = createContext<string | undefined>(undefined);

export const useOn = (): string | undefined => useContext(OnComputer);
