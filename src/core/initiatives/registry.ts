import type { Initiatives } from './initiatives.js';

const all = new WeakMap<object, Initiatives>();

export const attachInitiatives = (session: object, initiatives: Initiatives): void => void all.set(session, initiatives);
export const detachInitiatives = (session: object): void => void all.delete(session);
export const initiativesOf = (session: object): Initiatives | undefined => all.get(session);

export const needInitiatives = (session: object): Initiatives => {
  const found = all.get(session);
  if (!found) throw new Error('Initiatives need the Beluga app (its daemon): they are not available here.');
  return found;
};
