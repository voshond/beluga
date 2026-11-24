import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaHome } from '../home.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { sentinelOf } from '../sentinel/registry.js';
import { seedDemoInitiatives } from './demo.js';
import { type CheckInHost, Initiatives } from './initiatives.js';
import { attachInitiatives, detachInitiatives } from './registry.js';
import { repoRootOf } from './repo.js';

export type InitiativesHost = {
  readonly session: Session;
  readonly store: Store;
  readonly demo: boolean;
};

const checkInsOf = (session: Session): CheckInHost | undefined => {
  const sentinels = sentinelOf(session);
  if (!sentinels) return undefined;
  return {
    create: (draft) => sentinels.create(draft),
    exists: (id) => sentinels.list().some((s) => s.id === id),
    pause: (id, paused) => void sentinels.pause(id, paused),
    runNow: (id) => void sentinels.start(id, 'you'),
    remove: (id) => sentinels.remove(id),
  };
};

export const launchInitiatives = (host: InitiativesHost): (() => void) => {
  const { session, store, demo } = host;
  const demoRoot = demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-initiatives-')) : undefined;
  const root = demoRoot ?? repoRootOf(belugaHome());
  const initiatives = new Initiatives({
    store,
    root,
    dir: demo ? null : path.join(belugaHome(), 'initiatives'),
    selfId: () => session.selfId,
    ask: (prompt, channel) => session.askOwnClaude(prompt, channel, false),
    checkIns: () => checkInsOf(session),
    refine: (input) => session.refineGoal(input),
    commit: !demo,
  });
  attachInitiatives(session, initiatives);
  void initiatives
    .start()
    .then(() => (demoRoot ? seedDemoInitiatives(initiatives, demoRoot) : undefined))
    .catch((err: Error) => console.warn(`[initiatives] ${err.message}`));
  return () => {
    detachInitiatives(session);
    initiatives.stop();
    store.dispatch({ type: 'initiatives_off' });
    if (demoRoot) rmSync(demoRoot, { recursive: true, force: true });
  };
};
