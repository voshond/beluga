import { useSyncExternalStore } from 'react';
import type { SupportAsk } from '@beluga/core/support-store.js';

/**
 * Supporting Beluga: where the star and the coffee go, and the sheets opened by hand (Settings ›
 * About, the palette). The asks that come with merges are the daemon's (the shared state's
 * `support`, core/support-store.ts); these are the same sheets, any time, asking nothing back.
 */

export const GITHUB_URL = 'https://github.com/beluga-labs/beluga';

/** Who makes Beluga, shown as a GitHub chip (the avatar ships with the app: the window loads no remote images). */
export const MAINTAINER = { login: 'kayraucklnc', url: 'https://github.com/kayraucklnc' } as const;

/** The coffee amounts offered, in US dollars, with what each one buys. */
export const COFFEE_AMOUNTS = [5, 10, 20, 50] as const;
export type CoffeeAmount = (typeof COFFEE_AMOUNTS)[number];
export const COFFEE_WORDS: Readonly<Record<CoffeeAmount, string>> = { 5: 'A coffee', 10: 'Coffee & cake', 20: 'Lunch', 50: 'A whole day' };

/**
 * Stripe Payment Links: public checkout pages anyone may open (no keys, nothing secret, safe in a
 * public repo). A link can't be opened with an amount filled in, so an amount without a link of its
 * own goes to the one where you choose what to pay, and the sheet says what to type there. Give an
 * amount its own link (Stripe Dashboard › Payment Links) to make it one click.
 */
const PICK_AMOUNT = 'https://buy.stripe.com/6oU5kC1Xeg669in9tyfjG00';
export const COFFEE_LINKS: Readonly<Record<CoffeeAmount | 'other', string>> = {
  5: 'https://buy.stripe.com/dRmaEW1Xe7zAcuz49efjG01',
  10: PICK_AMOUNT,
  20: PICK_AMOUNT,
  50: PICK_AMOUNT,
  other: PICK_AMOUNT,
};

/** Whether this amount's link is set to it (else you type the amount on Stripe's page). */
export const exactLink = (amount: CoffeeAmount): boolean => COFFEE_LINKS[amount] !== PICK_AMOUNT;

// ---- a sheet opened by hand (one at a time)

let opened: SupportAsk | undefined;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of [...listeners]) l();
};

export function openSupport(ask: SupportAsk): void {
  opened = ask;
  emit();
}

export function closeSupport(): void {
  if (!opened) return;
  opened = undefined;
  emit();
}

/** The sheet you opened yourself, if any. */
export const useOpenedSupport = (): SupportAsk | undefined =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => opened,
  );
