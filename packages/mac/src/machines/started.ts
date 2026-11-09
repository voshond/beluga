/**
 * Work this window started on each computer (BLG-788), by its conversation: a demo computer is
 * this daemon pretending, and lists only the work it runs, so what you started there is its too.
 */
const started = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

export function noteStarted(machine: string, channel: string): void {
  started.set(machine, new Set([...(started.get(machine) ?? []), channel]));
  for (const l of [...listeners]) l();
}

export const startedOn = (machine: string): ReadonlyArray<{ readonly channel: string }> => [...(started.get(machine) ?? [])].map((channel) => ({ channel }));

export function onStarted(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
