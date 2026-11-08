import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/workspaces/store.js';

/** workspaces.json holds every workspace's usage: one that can't be read is kept, not silently replaced. */

describe('the workspace store', () => {
  it('copies a workspaces.json it can’t read aside, so the next save doesn’t lose it', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'ws-store-'));
    writeFileSync(path.join(home, 'workspaces.json'), '{"workspaces":[{"id":');
    const store = new WorkspaceStore(home);
    expect(store.loadRecords()).toEqual([]);
    store.saveRecords([]);
    const kept = readdirSync(home).filter((f) => f.startsWith('workspaces.json.unreadable-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(path.join(home, kept[0]!), 'utf8')).toBe('{"workspaces":[{"id":');
  });

  it('leaves nothing behind when there is no file yet', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'ws-store-'));
    const store = new WorkspaceStore(home);
    expect(store.loadRecords()).toEqual([]);
    expect(store.loadConfig().projects).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });
});
