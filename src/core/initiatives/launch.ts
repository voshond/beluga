import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaHome } from '../home.js';
import type { Session } from '../session.js';
import type { Store } from '../store.js';
import { sentinelOf } from '../sentinel/registry.js';
import type { Sentinels } from '../sentinel/sentinels.js';
import { seedDemoInitiatives } from './demo.js';
import { demoPeek } from './demo-success.js';
import type { SuccessHost } from './success-service.js';
import type { Source } from '../../shared/view-spec.js';
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
    reschedule: (id, trigger) => void sentinels.update(id, { trigger }),
    remove: (id) => sentinels.remove(id),
    rewrite: (id, patch) => void sentinels.update(id, patch),
  };
};

/** What an initiative's success needs from Sentinel (BLG-141); the demo answers queries from its stand-in BigQuery. */
export const successHostOf = (sentinels: Sentinels, demo: boolean): SuccessHost => ({
  peek: async (source, project) => {
    if (demo) return demoPeek(source);
    const preview = await sentinels.previewSource(source as Source, project);
    if (preview.state !== 'ok') throw new Error(preview.why ?? 'it did not run');
    return { columns: preview.columns, rows: preview.sample };
  },
  sentinelExists: (id) => sentinels.list().some((s) => s.id === id),
  createSentinel: (draft) => sentinels.create(draft),
  updateSentinel: (id, name, steps, projectId) => void sentinels.update(id, { name, steps, projectId }),
  pauseSentinel: (id) => void sentinels.pause(id, true),
  putDashboard: (id, name, tiles) => {
    const boards = sentinels.dashboards;
    const was = id ? boards.get(id) : undefined;
    const board = was ?? boards.create(name);
    for (const t of was?.tiles ?? []) boards.removeTile(board.id, t.id);
    for (const t of tiles) boards.addTile(board.id, t);
    return board.id;
  },
  points: (sentinelId, name) => {
    try {
      return sentinels.metricRead(sentinelId, name).lines;
    } catch {
      return [];
    }
  },
});

const successOf = (session: Session, demo: boolean): SuccessHost | undefined => {
  const sentinels = sentinelOf(session);
  return sentinels ? successHostOf(sentinels, demo) : undefined;
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
    ask: (prompt, channel) => session.askOwnClaude(prompt, channel, false, true, undefined, undefined, 'initiative'),
    checkIns: () => checkInsOf(session),
    refine: (input) => session.refineGoal(input),
    successHost: () => successOf(session, demo),
    defineSuccess: (req) => session.defineSuccess(req),
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
