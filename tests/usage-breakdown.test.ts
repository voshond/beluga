import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeFolderOf, readFolderUsage } from '../src/core/usage-files.js';
import { usageSummaryJson } from '../src/core/usage-report.js';

type Extra = Record<string, string | boolean>;

const claudeLine = (id: string, model: string, tokens: readonly [number, number, number, number], extra: Extra): string =>
  JSON.stringify({
    type: 'assistant',
    ...extra,
    message: { id, model, usage: { input_tokens: tokens[0], output_tokens: tokens[1], cache_read_input_tokens: tokens[2], cache_creation_input_tokens: tokens[3] } },
  });

const codexRollout = (thread: string, cwd: string, model: string, input: number, cached: number, output: number, sub = false): string =>
  [
    { type: 'session_meta', payload: { id: thread, cwd, model_provider: 'openai', source: sub ? { subagent: { thread_spawn: {} } } : 'exec' } },
    { type: 'turn_context', payload: { turn_id: `${thread}-t1`, model } },
    {
      type: 'token_usage_record',
      payload: { thread_id: thread, turn_id: `${thread}-t1`, response_id: `${thread}-r1`, usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output } },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');

const ALPHA = '/work/alpha';
const BETA = '/work/beta';

let root = '';
let claudeDir = '';
let codexDir = '';

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'usage-breakdown-'));
  claudeDir = path.join(root, 'claude');
  codexDir = path.join(root, 'codex');
  const alpha = claudeFolderOf(claudeDir, ALPHA);
  write(
    path.join(alpha, 's1.jsonl'),
    [
      claudeLine('m1', 'claude-opus-5-5', [10, 20, 300, 40], { cwd: ALPHA }),
      claudeLine('m1', 'claude-opus-5-5', [10, 25, 300, 40], { cwd: ALPHA }),
      claudeLine('m2', 'claude-opus-5-5', [1, 2, 3, 4], { cwd: `${ALPHA}/packages/mac` }),
    ].join('\n'),
  );
  write(path.join(alpha, 's1', 'subagents', 'agent-a.jsonl'), claudeLine('m3', 'claude-haiku-5-5', [5, 5, 50, 0], { cwd: ALPHA, isSidechain: true }));
  write(path.join(claudeFolderOf(claudeDir, BETA), 's2.jsonl'), claudeLine('m4', 'claude-opus-5-5', [100, 100, 100, 100], { cwd: BETA }));
  write(path.join(codexDir, '2026', '11', '10', 'rollout-a.jsonl'), codexRollout('ta', ALPHA, 'gpt-6.1-sol', 1000, 600, 30));
  write(path.join(codexDir, '2026', '11', '10', 'rollout-b.jsonl'), codexRollout('tb', ALPHA, 'gpt-6-luna', 200, 100, 5, true));
  write(path.join(codexDir, '2026', '11', '10', 'rollout-c.jsonl'), codexRollout('tc', BETA, 'gpt-6.1-sol', 9999, 0, 9999));
  write(path.join(codexDir, '2026', '11', '10', 'rollout-d.jsonl'), codexRollout('td', `${ALPHA}-other`, 'gpt-6.1-sol', 7777, 0, 7777));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a worktree usage breakdown', () => {
  it('reads only the folder logs, by provider and model, with sub-agents apart', async () => {
    const summary = await readFolderUsage(ALPHA, { claudeDir, codexDir });
    expect(summary.agents.map((a) => a.agent)).toEqual([ALPHA, `${ALPHA} (sub-agents)`]);
    const [main, sub] = summary.agents;
    expect(main?.models.map((m) => [m.provider, m.model, m.messages, m.input, m.output, m.cacheRead, m.cacheWrite, m.total])).toEqual([
      ['anthropic', 'claude-opus-5-5', 2, 11, 27, 303, 44, 385],
      ['openai', 'gpt-6.1-sol', 1, 400, 30, 600, 0, 1030],
    ]);
    expect(sub?.models.map((m) => [m.provider, m.model, m.total])).toEqual([
      ['anthropic', 'claude-haiku-5-5', 60],
      ['openai', 'gpt-6-luna', 205],
    ]);
    expect(summary.total).toBe(385 + 1030 + 60 + 205);
  });

  it('leaves out other worktrees, even one whose path starts the same', async () => {
    const summary = await readFolderUsage(ALPHA, { claudeDir, codexDir });
    expect(summary.total).toBeLessThan(7777);
    const beta = await readFolderUsage(BETA, { claudeDir, codexDir });
    expect(beta.total).toBe(400 + 9999 + 9999);
  });

  it('gives the same answer every time', async () => {
    const first = usageSummaryJson(await readFolderUsage(ALPHA, { claudeDir, codexDir }));
    expect(usageSummaryJson(await readFolderUsage(ALPHA, { claudeDir, codexDir }))).toBe(first);
  });

  it('is empty when there are no logs', async () => {
    const summary = await readFolderUsage('/work/none', { claudeDir: path.join(root, 'missing'), codexDir: path.join(root, 'missing') });
    expect(summary.agents).toEqual([]);
    expect(summary.total).toBe(0);
  });
});
