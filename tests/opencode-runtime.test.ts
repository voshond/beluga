import { describe, expect, it } from 'vitest';
import { runtimeFor, signInCommand } from '../src/agent/runtime/registry.js';
import { routedBackend } from '../src/agent/runtime/router.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { runtimeChoices } from '../src/shared/agent-runtimes.js';
import { agentBadge } from '../src/shared/agent-label.js';

/**
 * GitHub #316 (BLG-686): OpenCode as an agent you can pick, beside Claude, Codex and a local model.
 * Each expectation is what a person sees now it's supported (before, all of them failed: Beluga
 * knew exactly three runtimes and OpenCode was none of them). How it runs: opencode-flow.test.ts.
 */
describe('OpenCode as a runtime (#316)', () => {
  it('is registered, says whether it is set up here, and how to sign in', () => {
    const rt = runtimeFor('opencode');
    expect(rt?.label).toBe('OpenCode');
    expect(rt?.status).toBeTypeOf('function');
    expect(signInCommand('opencode')?.slice(1)).toEqual(['auth', 'login']);
  });

  it('is listed in the agent picker, greyed with a reason when it is not installed', () => {
    const choice = runtimeChoices(() => undefined).find((r) => r.id === 'opencode');
    expect(choice).toMatchObject({ label: 'OpenCode', available: false });
    expect(choice?.why).toMatch(/OpenCode/);
  });

  it('is named OpenCode on a message badge', () => {
    expect(agentBadge({ runtime: 'opencode', label: 'Helper' })).toBe('OpenCode');
  });

  it('runs a worktree whose agent is OpenCode instead of refusing it', async () => {
    const claude = { run: async () => undefined } as unknown as AgentBackend;
    const opencode = runtimeFor('opencode');
    const routed = routedBackend(claude, 'claude', (id) => (id === 'opencode' && opencode ? ({ run: async () => undefined } as unknown as AgentBackend) : undefined));
    const input = { prompt: 'hi', place: { agent: { runtime: 'opencode', label: 'OpenCode' } } } as unknown as AgentRunInput;
    await expect(routed.run(input)).resolves.toBeUndefined();
  });
});
