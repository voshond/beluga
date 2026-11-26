import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stepEffort } from '../src/core/sentinel/model.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController } from '../src/core/workspace-controller.js';
import type { AgentRef } from '../src/protocol.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { screenOver } from './helpers.js';
import { fakePlaces, setup, until } from './sentinel-fakes.js';

/** BLG-498: an Ask Your Agent step's effort reaches its run, when its model takes it. */

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

describe('stepEffort', () => {
  it('a known effort its model takes; none, an unknown word or one the model doesn’t take: Settings’', () => {
    expect(stepEffort({ effort: 'high' }, undefined)).toBe('high');
    expect(stepEffort({ effort: 'high' }, ['low', 'medium', 'high'])).toBe('high');
    expect(stepEffort({ effort: 'max' }, ['low', 'medium', 'high'])).toBeUndefined();
    expect(stepEffort({ effort: 'turbo' }, undefined)).toBeUndefined();
    expect(stepEffort({}, ['high'])).toBeUndefined();
  });
});

describe('a step’s effort in its run', () => {
  it('goes with the step’s agent to the run’s chat, only when its model takes it', async () => {
    const set: Array<[string, AgentRef | undefined, string | undefined]> = [];
    const p = fakePlaces();
    const s = setup({ reply: () => 'ok', places: { ...p.places, setAgent: (id, agent, effort) => void set.push([id, agent, effort]) } });
    s.store.dispatch({ type: 'models', models: [{ value: 'opus', label: 'Opus', description: '', efforts: ['low', 'medium', 'high', 'max'] }, { value: 'haiku', label: 'Haiku', description: '', efforts: ['low'] }] });
    const made = s.sentinels.create({
      name: 'Efforts',
      projectId: 'api',
      steps: [
        { kind: 'claude', name: 'Hard', where: 'project', prompt: 'Think', runtime: 'claude', model: 'opus', effort: 'max' },
        { kind: 'claude', name: 'Quick', where: 'project', prompt: 'Skim', runtime: 'claude', model: 'haiku', effort: 'high' },
        { kind: 'claude', name: 'Default', where: 'project', prompt: 'Sum up', effort: 'medium' },
      ],
    });
    const run = s.sentinels.start(made.id, 'you');
    await until(() => !['queued', 'running'].includes(s.sentinels.runGet(run.id).run.state));
    expect(set).toEqual([
      ['c1', { runtime: 'claude', label: 'Claude', model: 'opus' }, 'max'],
      // Haiku doesn't take high: Settings' effort.
      ['c1', { runtime: 'claude', label: 'Claude', model: 'haiku' }, undefined],
      // No agent of its own: Claude on Settings' sentinel model; its levels aren't known, so the step's effort goes as it is.
      ['c1', { runtime: 'claude', label: 'Claude', model: 'sonnet' }, 'medium'],
    ]);
    expect(s.sentinels.runGet(run.id).run.steps.map((st) => st.model)).toEqual(['opus', 'haiku', 'sonnet']);
  });

  it('a step with no agent follows your default when the sentinel model is empty or your agent isn’t Claude', async () => {
    const set: Array<AgentRef | undefined> = [];
    const p = fakePlaces();
    const s = setup({ reply: () => 'ok', places: { ...p.places, setAgent: (_id, agent) => void set.push(agent) } });
    const made = s.sentinels.create({ name: 'Default', projectId: 'api', steps: [{ kind: 'claude', where: 'project', prompt: 'Sum up' }] });
    s.store.dispatch({ type: 'prefs', prefs: { sentinelModel: '' } });
    const first = s.sentinels.start(made.id, 'you');
    await until(() => !['queued', 'running'].includes(s.sentinels.runGet(first.id).run.state));
    s.store.dispatch({ type: 'prefs', prefs: { sentinelModel: 'haiku', defaultAgent: { runtime: 'codex', label: 'Codex' } } });
    const second = s.sentinels.start(made.id, 'you');
    await until(() => !['queued', 'running'].includes(s.sentinels.runGet(second.id).run.state));
    expect(set).toEqual([undefined, undefined]);
    expect(s.sentinels.runGet(second.id).run.steps[0]?.model).toBeUndefined();
  });

  it('a workspace’s effort is its place’s, and a new agent clears it', async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-effort-')));
    const repo = path.join(base, 'code', 'app');
    mkdirSync(repo, { recursive: true });
    sh(repo, 'init', '-b', 'main');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-m', 'init');
    const wsStore = new WorkspaceStore(path.join(base, 'home'));
    wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
    const store = new Store(initialState('room'));
    const manager = new WorkspaceManager(wsStore);
    const ctl = new WorkspaceController({ manager, store, shares: new ShareService([]), selfId: () => 'me', toast: () => undefined, intend: screenOver(store).intend, askClaude: () => undefined, claudeHome: path.join(base, 'claude') });
    await ctl.refresh();
    const projectId = store.getState().projects.find((x) => x.root)!.id;
    const ws = (await ctl.newChat(projectId, 'effort', undefined, { quiet: true }))!;
    const ch = `ws:${ws.id}`;
    manager.setAgent(ws.id, { runtime: 'claude', label: 'Claude', model: 'opus' });
    manager.setEffort(ws.id, 'max');
    expect(ctl.place(ch)).toMatchObject({ model: 'opus', effort: 'max' });
    manager.setAgent(ws.id, undefined);
    expect(ctl.place(ch)?.effort).toBeUndefined();
  });
});
