import { rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from '../../net/mesh/files.js';
import { secretIn } from '../../shared/secret-text.js';
import { belugaHome } from '../home.js';
import type { Outgoing } from './filter.js';

/**
 * Messages waiting to go to Honcho (BLG-103), kept in ~/.beluga/honcho-queue.json (0600) so a
 * restart sends them once it's back. They are your own words, so the file is tied to the server
 * and workspace they were meant for: anywhere else, it is dropped unread.
 */

export type QueueTarget = { readonly url: string; readonly workspace: string };

const Item = z.object({
  id: z.string().min(1).max(500),
  conversation: z.object({
    channel: z.string().max(500),
    session: z.string().max(512),
    kind: z.enum(['worktree', 'chat', 'main', 'your-mac', 'initiative']),
    projectId: z.string().max(500).optional(),
    projectName: z.string().max(500).optional(),
    title: z.string().max(2000).optional(),
  }),
  peer: z.object({ id: z.string().max(512), role: z.enum(['user', 'agent']) }),
  content: z.string(),
  ts: z.number(),
  metadata: z.record(z.string(), z.string()),
});

const Saved = z.object({ url: z.string(), workspace: z.string(), items: z.array(Item).max(5000) });

export const honchoQueuePath = (): string => path.join(belugaHome(), 'honcho-queue.json');

const safeToKeep = (item: Outgoing): boolean => !secretIn(JSON.stringify(item));

export const loadHonchoQueue = (file: string, target: QueueTarget): Outgoing[] => {
  const parsed = Saved.safeParse(readJson(file));
  if (!parsed.success) return [];
  if (parsed.data.url !== target.url || parsed.data.workspace !== target.workspace) return [];
  return parsed.data.items.filter(safeToKeep);
};

export const saveHonchoQueue = (file: string, target: QueueTarget, items: readonly Outgoing[]): void => {
  const kept = items.filter(safeToKeep);
  if (!kept.length) return removeHonchoQueue(file);
  writeJson(file, { url: target.url, workspace: target.workspace, items: kept });
};

export const removeHonchoQueue = (file: string): void => {
  try {
    rmSync(file, { force: true });
  } catch {
    return;
  }
};
