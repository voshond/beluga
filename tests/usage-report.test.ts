import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatUsageSummary, providerOfModel, recordsFromTranscript, summarizeUsage, usageSummaryJson } from '../src/core/usage-report.js';

type Usage = { input: number; output: number; read: number; write: number };

const assistant = (id: string, model: string, usage: Usage, extra: Record<string, string | boolean> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model,
      usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write },
    },
    ...extra,
  });

const ALPHA = '/work/alpha';
const BETA = '/work/beta';

const alphaTranscript = [
  JSON.stringify({ type: 'user', cwd: ALPHA, message: { role: 'user', content: 'hello' } }),
  assistant('msg_1', 'claude-opus-5-5', { input: 10, output: 5, read: 1000, write: 200 }, { cwd: ALPHA }),
  assistant('msg_1', 'claude-opus-5-5', { input: 10, output: 20, read: 1000, write: 200 }, { cwd: ALPHA }),
  assistant('msg_1', 'claude-opus-5-5', { input: 10, output: 40, read: 1000, write: 200 }, { cwd: ALPHA }),
  '',
  'this is not json {',
  assistant('msg_2', 'claude-sonnet-4-6', { input: 3, output: 7, read: 500, write: 0 }, { cwd: ALPHA }),
  assistant('msg_3', '<synthetic>', { input: 0, output: 0, read: 0, write: 0 }, { cwd: ALPHA }),
  assistant('msg_4', 'claude-sonnet-4-6', { input: 2, output: 8, read: 300, write: 50 }, { cwd: ALPHA, isSidechain: true }),
].join('\n');

const betaTranscript = [
  assistant('msg_5', 'claude-opus-5-5', { input: 100, output: 50, read: 2000, write: 400 }, { cwd: BETA }),
  assistant('msg_6', 'gpt-5', { input: 30, output: 60, read: 0, write: 0 }, { cwd: BETA }),
  assistant('msg_7', 'claude-sonnet-4-6', { input: 1, output: 2, read: 3, write: 4 }),
].join('\n');

const records = () => [...recordsFromTranscript(alphaTranscript, 'fallback-alpha'), ...recordsFromTranscript(betaTranscript, 'fallback-beta')];

const EXPECTED_TEXT = `Agent usage: 4 agents, 3 models, 4,770 tokens
Total = input + output + cache read + cache write.

/work/alpha  (1,760 tokens)
  Provider   Model              Messages  Input  Output  Cache read  Cache write  Total
  ---------  -----------------  --------  -----  ------  ----------  -----------  -----
  anthropic  claude-opus-5-5           1     10      40       1,000          200  1,250
  anthropic  claude-sonnet-4-6         1      3       7         500            0    510

/work/alpha (sub-agents)  (360 tokens)
  Provider   Model              Messages  Input  Output  Cache read  Cache write  Total
  ---------  -----------------  --------  -----  ------  ----------  -----------  -----
  anthropic  claude-sonnet-4-6         1      2       8         300           50    360

/work/beta  (2,640 tokens)
  Provider   Model            Messages  Input  Output  Cache read  Cache write  Total
  ---------  ---------------  --------  -----  ------  ----------  -----------  -----
  anthropic  claude-opus-5-5         1    100      50       2,000          400  2,550
  openai     gpt-5                   1     30      60           0            0     90

fallback-beta  (10 tokens)
  Provider   Model              Messages  Input  Output  Cache read  Cache write  Total
  ---------  -----------------  --------  -----  ------  ----------  -----------  -----
  anthropic  claude-sonnet-4-6         1      1       2           3            4     10

All agents
  Provider   Model              Messages  Input  Output  Cache read  Cache write  Total
  ---------  -----------------  --------  -----  ------  ----------  -----------  -----
  anthropic  claude-opus-5-5           2    110      90       3,000          600  3,800
  anthropic  claude-sonnet-4-6         3      6      17         803           54    880
  openai     gpt-5                     1     30      60           0            0     90
  all                                  6    146     167       3,803          654  4,770
`;

describe('usage report', () => {
  it('totals tokens per agent, grouped by provider and model', () => {
    const summary = summarizeUsage(records());
    expect(summary.agents.map((a) => a.agent)).toEqual(['/work/alpha', '/work/alpha (sub-agents)', '/work/beta', 'fallback-beta']);
    const alpha = summary.agents[0]!;
    expect(alpha.models).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5-5', input: 10, output: 40, cacheRead: 1000, cacheWrite: 200, messages: 1, total: 1250 },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', input: 3, output: 7, cacheRead: 500, cacheWrite: 0, messages: 1, total: 510 },
    ]);
    expect(alpha.total).toBe(1760);
    const beta = summary.agents[2]!;
    expect(beta.models.map((m) => [m.provider, m.model, m.total])).toEqual([
      ['anthropic', 'claude-opus-5-5', 2550],
      ['openai', 'gpt-5', 90],
    ]);
    expect(beta.total).toBe(2640);
    expect(summary.total).toBe(1760 + 360 + 2640 + 10);
    expect(summary.messages).toBe(6);
  });

  it('counts a message id once even when it is written several times', () => {
    const summary = summarizeUsage(recordsFromTranscript(alphaTranscript, 'x'));
    const opus = summary.models.find((m) => m.model === 'claude-opus-5-5');
    expect(opus).toMatchObject({ messages: 1, input: 10, output: 40, cacheRead: 1000, cacheWrite: 200 });
  });

  it('lists sub-agent lines apart from their parent folder', () => {
    const summary = summarizeUsage(recordsFromTranscript(alphaTranscript, 'x'));
    const sub = summary.agents.find((a) => a.agent === '/work/alpha (sub-agents)');
    expect(sub?.total).toBe(360);
    expect(sub?.models).toHaveLength(1);
  });

  it('ignores synthetic, user and malformed lines and uses the fallback agent without a cwd', () => {
    const parsed = recordsFromTranscript(alphaTranscript, 'x');
    expect(parsed).toHaveLength(5);
    expect(parsed.some((r) => r.model === '<synthetic>')).toBe(false);
    const fallback = recordsFromTranscript(betaTranscript, 'fallback-beta').filter((r) => r.agent === 'fallback-beta');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({ model: 'claude-sonnet-4-6', input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  });

  it('names the provider of a model', () => {
    expect(providerOfModel('claude-opus-5-5')).toBe('anthropic');
    expect(providerOfModel('gpt-5')).toBe('openai');
    expect(providerOfModel('o3')).toBe('openai');
    expect(providerOfModel('gemini-2.5-pro')).toBe('google');
    expect(providerOfModel('ollama/llama3')).toBe('ollama');
    expect(providerOfModel('something-else')).toBe('unknown');
  });

  it('gives identical output whatever order the records come in', () => {
    const forward = summarizeUsage(records());
    const reversed = summarizeUsage([...records()].reverse());
    const rotated = summarizeUsage([...records().slice(4), ...records().slice(0, 4)]);
    for (const other of [reversed, rotated]) {
      expect(formatUsageSummary(other)).toBe(formatUsageSummary(forward));
      expect(usageSummaryJson(other)).toBe(usageSummaryJson(forward));
    }
  });

  it('files a message id seen under two agents under the same one whatever the order', () => {
    const main = recordsFromTranscript(assistant('msg_x', 'claude-opus-5-5', { input: 1, output: 2, read: 3, write: 4 }, { cwd: ALPHA }), 'x');
    const sub = recordsFromTranscript(assistant('msg_x', 'claude-opus-5-5', { input: 1, output: 9, read: 3, write: 4 }, { cwd: ALPHA, isSidechain: true }), 'x');
    const a = summarizeUsage([...main, ...sub]);
    const b = summarizeUsage([...sub, ...main]);
    expect(usageSummaryJson(a)).toBe(usageSummaryJson(b));
    expect(a.agents.map((g) => [g.agent, g.total])).toEqual([[ALPHA, 17]]);
  });

  it('prints the full text report exactly', () => {
    expect(formatUsageSummary(summarizeUsage(records()))).toBe(EXPECTED_TEXT);
  });

  it('says so when there is no usage', () => {
    expect(formatUsageSummary(summarizeUsage([]))).toBe('No recorded agent usage found.\n');
  });
});

describe('usage summary script', () => {
  it('reads nested transcripts and prints the same thing every time', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'usage-report-'));
    try {
      mkdirSync(path.join(tmp, '-work-alpha', 'session-1', 'subagents'), { recursive: true });
      mkdirSync(path.join(tmp, '-work-beta'), { recursive: true });
      writeFileSync(path.join(tmp, '-work-alpha', 'session-1.jsonl'), alphaTranscript.split('\n').slice(0, 8).join('\n'));
      writeFileSync(path.join(tmp, '-work-alpha', 'session-1', 'subagents', 'agent-a.jsonl'), alphaTranscript.split('\n')[8]!);
      writeFileSync(path.join(tmp, '-work-beta', 'session-2.jsonl'), betaTranscript);
      writeFileSync(path.join(tmp, '-work-beta', 'notes.txt'), 'not a transcript');
      const run = (...flags: string[]): string =>
        execFileSync(process.execPath, ['--import', 'tsx', 'scripts/usage-summary.ts', '--dir', tmp, ...flags], { encoding: 'utf8' });
      const first = run();
      expect(run()).toBe(first);
      expect(first).toContain('/work/alpha (sub-agents)');
      expect(first).toContain('-work-beta');
      const json = JSON.parse(run('--json')) as { total: number; messages: number };
      expect(json.total).toBe(1760 + 360 + 2640 + 10);
      expect(json.messages).toBe(6);
      expect(run('--json')).toBe(run('--json'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
