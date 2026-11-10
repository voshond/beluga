import { describe, expect, it } from 'vitest';
import { latestModels, modelFamily } from '../src/shared/model-families.js';
import { agentPicker } from '../src/shared/agent-picker.js';
import { runtimeChoices } from '../src/shared/agent-runtimes.js';
import { agentChoices } from '../src/ui/agent-choice.js';

const CLAUDE = [
  { value: '', label: 'Default', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'opus', label: 'Opus 5.5', description: 'For complex work and everyday tasks' },
  { value: 'claude-fable-5-2', label: 'Fable 5.2', description: 'For your toughest challenges' },
  { value: 'sonnet', label: 'Sonnet 5.5', description: 'Most efficient for simpler tasks' },
  { value: 'haiku', label: 'Haiku 5.5', description: 'Fastest for quick answers' },
  { value: 'fable', label: 'Fable 5.1', description: 'Most capable' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fastest for quick answers' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Efficient for routine tasks' },
  { value: 'claude-opus-5', label: 'Opus 5', description: 'Best for everyday, complex tasks' },
  { value: 'claude-fable-5', label: 'Fable 5', description: 'Most capable' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Best for everyday, complex tasks' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7', description: 'Best for everyday, complex tasks' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: 'Efficient for routine tasks' },
];

const CODEX = [
  { value: '', label: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.' },
  { value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', description: 'GPT-6.1 Terra Codex model.' },
  { value: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.' },
  { value: 'gpt-6-sol', label: 'GPT-6-Sol', description: 'Previous generation workhorse model.' },
  { value: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Older generation workhorse model.' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work.' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: 'Older fast and efficient model.' },
];

describe('the newest model of each family (BLG-82)', () => {
  it('reads a family and its version from the name', () => {
    expect(modelFamily('Opus 4.8')).toEqual({ family: 'opus', version: [4, 8] });
    expect(modelFamily('GPT-6.1 Terra')).toEqual({ family: 'gpt terra', version: [6, 1] });
    expect(modelFamily('GPT-5.6-Terra')).toEqual({ family: 'gpt terra', version: [5, 6] });
    expect(modelFamily('Default')).toBeUndefined();
  });

  it('Claude’s 13 rows become Default and the newest Opus, Fable, Sonnet and Haiku', () => {
    expect(latestModels(CLAUDE).map((m) => m.label)).toEqual(['Default', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5']);
  });

  it('Codex keeps its default (the newest Sol) and the newest Terra, Astra and Luna', () => {
    expect(latestModels(CODEX).map((m) => m.label)).toEqual(['GPT-6.1-Sol', 'GPT-6.1 Terra', 'GPT-6-Astra', 'GPT-6-Luna']);
  });

  it('an older model you picked stays listed, so its row is still the checked one', () => {
    expect(latestModels(CLAUDE, ['claude-opus-4-7']).map((m) => m.label)).toContain('Opus 4.7');
    const state = { runtimes: runtimeChoices(() => ({})), models: CLAUDE, prefs: {}, projects: [{ workspaces: [{ id: 'a', model: 'claude-opus-4-7' }] }] };
    const p = agentPicker(state, 'ws:a');
    expect(p.label).toBe('Opus 4.7');
    expect(p.groups[0]?.models.filter((m) => m.on).map((m) => m.label)).toEqual(['Opus 4.7']);
    expect(agentPicker(state, 'room').groups[0]?.models.map((m) => m.label)).not.toContain('Opus 4.7');
  });

  it('Settings’ agent list is cleaned the same way', () => {
    const labels = agentChoices([{ id: 'claude', label: 'Claude', available: true }], CLAUDE).map((o) => o.label);
    expect(labels).toEqual(['Claude', 'Claude · Opus 5.5', 'Claude · Fable 5.2', 'Claude · Sonnet 5.5', 'Claude · Haiku 5.5']);
  });
});
