import type { ToolboxService } from './service.js';

/** The toolbox service for a session. */
const all = new WeakMap<object, ToolboxService>();

export const attachToolbox = (session: object, service: ToolboxService): void => void all.set(session, service);
export const detachToolbox = (session: object): void => void all.delete(session);
export const toolboxOf = (session: object): ToolboxService | undefined => all.get(session);

export function needToolbox(session: object): ToolboxService {
  const s = all.get(session);
  if (!s) throw new Error('Toolbox needs the Beluga app (its daemon).');
  return s;
}
