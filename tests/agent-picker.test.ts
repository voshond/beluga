import { describe, expect, it } from 'vitest';
import { type PickerState, agentPicker, pickAction } from '../src/shared/agent-picker.js';
import { runtimeChoices } from '../src/shared/agent-runtimes.js';
import { modelMenu } from '../src/ui/settings-menus.js';
import type { AppState } from '../src/core/store.js';
import { demoPicker } from '../packages/companion/lib/link/demo/agents.js';

/** BLG-446: the agent picker, runtimes as groups with their models, the Mac's, /model's and the phone's. */

const CLAUDE_MODELS = [
  { value: '', label: 'Default', description: "Claude Code's choice" },
  { value: 'opus', label: 'Opus', description: 'most capable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', label: 'Haiku', description: 'fastest' },
];

function state(workspaces: PickerState['projects'][number]['workspaces'] = [], codex = true, model?: string): PickerState {
  return {
    runtimes: runtimeChoices((id) => (id === 'claude' ? {} : id === 'codex' && codex ? { models: [{ value: 'gpt-5-codex', label: 'GPT-5 Codex', description: 'for code' }] } : undefined)),
    models: CLAUDE_MODELS,
    prefs: model ? { model } : {},
    projects: [{ workspaces }],
  };
}

describe('agentPicker', () => {
  it('groups by runtime, your default first, and keeps one this Mac does not run, saying why', () => {
    const p = agentPicker(state([], false), 'ws:a');
    expect(p.groups.map((g) => [g.runtime, g.available, g.isDefault])).toEqual([
      ['claude', true, true],
      ['codex', false, false],
      ['opencode', false, false],
      ['copilot', false, false],
      ['local', false, false],
    ]);
    expect(p.groups[1]).toMatchObject({ why: "Codex isn't set up on this Mac yet", models: [] });
    expect(p.groups[2]).toMatchObject({ why: "OpenCode isn't set up on this Mac yet", models: [] });
    expect(p.groups[3]).toMatchObject({ why: "GitHub Copilot CLI isn't set up on this Mac yet", models: [] });
    expect(p.groups[4]?.why).toBe('No local model endpoint is set');
    expect(p.groups[0]?.models.map((m) => m.label)).toEqual(['Default', 'Opus', 'Haiku']);
  });

  it("remembers each place's own choice", () => {
    const st = state([
      { id: 'a', model: 'opus' },
      { id: 'b', agent: { runtime: 'codex', label: 'Codex' }, model: 'gpt-5-codex' },
    ]);
    const a = agentPicker(st, 'ws:a');
    expect(a).toMatchObject({ runtime: 'claude', model: 'opus', label: 'Opus' });
    expect(a.groups[0]?.models.find((m) => m.on)?.value).toBe('opus');
    const b = agentPicker(st, 'ws:b');
    expect(b).toMatchObject({ runtime: 'codex', model: 'gpt-5-codex', label: 'Codex · GPT-5 Codex' });
    expect(b.groups.find((g) => g.current)?.runtime).toBe('codex');
    expect(b.groups[0]?.models.some((m) => m.on)).toBe(false);
    // New conversations: your default's model; a new worktree's own pick before it exists.
    expect(agentPicker(state([], true, 'haiku'), 'draft')).toMatchObject({ runtime: 'claude', model: 'haiku', label: 'Haiku' });
    expect(agentPicker(state(), 'draft', 'claude', { runtime: 'codex', label: 'Codex', model: 'gpt-5-codex' })).toMatchObject({ runtime: 'codex', label: 'Codex · GPT-5 Codex' });
  });

  it('a same-runtime pick changes the model; another runtime changes the agent', () => {
    const st = state([{ id: 'a' }, { id: 'b', agent: { runtime: 'codex', label: 'Codex' } }]);
    const a = agentPicker(st, 'ws:a');
    const [claude, codex] = a.groups;
    expect(pickAction(a, claude!, 'opus')).toEqual({ kind: 'model', value: 'opus' });
    expect(pickAction(a, codex!, 'gpt-5-codex')).toEqual({ kind: 'agent', agent: { runtime: 'codex', label: 'Codex', model: 'gpt-5-codex' } });
    const b = agentPicker(st, 'ws:b');
    expect(pickAction(b, b.groups[0]!, '')).toEqual({ kind: 'agent', agent: null });
    expect(pickAction(b, b.groups[0]!, 'opus')).toEqual({ kind: 'agent', agent: { runtime: 'claude', label: 'Claude', model: 'opus' } });
    // New conversations: pickAction returns undefined for non-default group (by design — the
    // ModelPicker uses the onDraft branch instead, BLG-83).
    const d = agentPicker(st, 'draft');
    expect(pickAction(d, d.groups[1]!, 'gpt-5-codex')).toBeUndefined();
    // But a new chat can carry a draft Codex agent via the picker's onDraft prop (BLG-83).
    const withCodex = agentPicker(st, 'draft', 'claude', { runtime: 'codex', label: 'Codex', model: 'gpt-5-codex' });
    expect(withCodex).toMatchObject({ runtime: 'codex', label: 'Codex · GPT-5 Codex' });
    expect(withCodex.groups.find((g) => g.current)?.runtime).toBe('codex');
    // Once Codex is the draft runtime, same-runtime picks are model changes (not undefined).
    const codexGroup = withCodex.groups.find((g) => g.runtime === 'codex')!;
    expect(pickAction(withCodex, codexGroup, 'gpt-5-codex')).toEqual({ kind: 'model', value: 'gpt-5-codex' });
  });
});

describe('/model', () => {
  it('lists runtimes as groups: models of this one switch models, of another switch agent', () => {
    const st = { ...state([{ id: 'a', model: 'opus' }], false), inbox: [] } as unknown as AppState;
    const menu = modelMenu(st, 'ws:a', 'this conversation');
    const ids = menu.options.map((o) => o.id);
    expect(ids).toEqual(['runtime:claude', 'model:', 'model:opus', 'model:haiku', 'runtime:codex', 'runtime:opencode', 'runtime:copilot', 'runtime:local', 'close']);
    expect(menu.options.find((o) => o.id === 'model:opus')?.label).toContain('◉');
    expect(menu.options.find((o) => o.id === 'runtime:codex')?.hint).toBe("Codex isn't set up on this Mac yet");
    const withCodex = modelMenu({ ...st, ...state([{ id: 'a' }]) } as unknown as AppState, 'ws:a', 'this conversation');
    expect(withCodex.options.map((o) => o.id)).toContain('agent:codex:gpt-5-codex');
  });
});

describe("the phone's demo picker", () => {
  it('shows the groups, and a pick moves the check', () => {
    const p = demoPicker();
    expect(p.groups.map((g) => [g.runtime, g.available])).toEqual([
      ['claude', true],
      ['codex', true],
      ['local', false],
    ]);
    expect(p.label).toBe('Default');
    const codex = demoPicker('codex', 'gpt-5-codex');
    expect(codex.label).toBe('Codex · GPT-5 Codex');
    expect(codex.groups.flatMap((g) => g.models.filter((m) => m.on).map((m) => `${g.runtime}:${m.value}`))).toEqual(['codex:gpt-5-codex']);
  });
});

describe('agentPicker with Auto (BLG-82, routed task runs)', () => {
  const auto = { runtime: 'claude', chip: 'Auto · Opus', description: 'Sized medium from its task', active: true };

  it('the default row becomes Auto, checked, and the chip says what it routed to, over your Settings model', () => {
    const p = agentPicker(state([{ id: 'a' }], true, 'haiku'), 'ws:a', 'claude', undefined, auto);
    expect(p.label).toBe('Auto · Opus');
    expect(p.groups[0]?.models.map((m) => [m.label, m.on])).toEqual([
      ['Auto', true],
      ['Opus', false],
      ['Haiku', false],
    ]);
    expect(p.groups[0]?.models[0]?.description).toBe('Sized medium from its task');
  });

  it('a model picked for the conversation stays checked, and Auto is the row that goes back', () => {
    const p = agentPicker(state([{ id: 'a', model: 'haiku' }]), 'ws:a', 'claude', undefined, { ...auto, active: false });
    expect(p.label).toBe('Haiku');
    expect(p.groups[0]?.models.map((m) => [m.label, m.on])).toEqual([
      ['Auto', false],
      ['Opus', false],
      ['Haiku', true],
    ]);
    expect(pickAction(p, p.groups[0]!, '')).toEqual({ kind: 'model', value: '' });
  });

  it('on Codex it adds the Auto row when its list has no default one, and says Codex in the chip', () => {
    const p = agentPicker(state([{ id: 'a', agent: { runtime: 'codex', label: 'Codex' } }]), 'ws:a', 'claude', undefined, { ...auto, runtime: 'codex', chip: 'Auto · Frontier' });
    expect(p.label).toBe('Codex · Auto · Frontier');
    expect(p.groups.find((g) => g.runtime === 'codex')?.models.map((m) => [m.label, m.on])).toEqual([
      ['Auto', true],
      ['GPT-5 Codex', false],
    ]);
  });
});
