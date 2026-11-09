/**
 * Run New Work On as this device reads it (BLG-836). The setting syncs with your other settings
 * (sync.ts), so a computer of yours receives what your app chose, often a computer's id (maybe its
 * own). Work only goes elsewhere from your app: on a computer it always means here, and on any
 * device a value naming that device itself, or a computer it doesn't know, means here too. The
 * synced value itself is never changed, so your apps keep their choice.
 *
 * Whatever routes new work (placement, the router) reads it through `runOnHere`.
 */

/** This device, as Run New Work On needs it: whether it's your app or a computer, its id, and the computers it knows. */
export interface RunOnDevice {
  readonly role: 'app' | 'computer';
  readonly id: string;
  readonly computers: readonly string[];
}

/** What Run New Work On means on this device: `here`, `best`, or a computer it knows by id. */
export function runOnHere(runOn: string, device: RunOnDevice): string {
  if (device.role === 'computer') return 'here';
  if (runOn === 'here' || runOn === 'best') return runOn;
  if (runOn === device.id || !device.computers.includes(runOn)) return 'here';
  return runOn;
}
