import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which client's request the core is working on right now (kept across awaits), so what it
 * causes (going somewhere, a message on screen) reaches that client and not every screen.
 */
const current = new AsyncLocalStorage<string>();

export const runAsClient = <T>(clientId: string, fn: () => T): T => current.run(clientId, fn);

/** The client whose request is being handled, or undefined for things that just happen (a friend's message). */
export const currentClient = (): string | undefined => current.getStore();

/** The phone's link calls as `phone:<device>` (companion/host.ts): whether this request is the phone's. */
export const fromPhone = (): boolean => currentClient()?.startsWith('phone:') ?? false;

/** Your app on another computer driving this one (daemon/clients.ts, BLG-803): whether this request is its. */
export const fromMachine = (): boolean => currentClient()?.startsWith('machine:') ?? false;
