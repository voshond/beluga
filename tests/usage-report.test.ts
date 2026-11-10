import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultClaudeDir, defaultCodexDir } from '../src/core/usage-files.js';
import { formatUsageSummary, providerOfModel, recordsFromCodexRollout, recordsFromTranscript, summarizeUsage, usageSummaryJson } from '../src/core/usage-report.js';

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
        execFileSync(process.execPath, ['--import', 'tsx', 'scripts/usage-summary.ts', '--claude-dir', tmp, ...flags], { encoding: 'utf8' });
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

const codexLine = (type: string, payload: object): string => JSON.stringify({ type, payload });

const codexRecord = (threadId: string, turnId: string, responseId: string, input: number, cached: number, write: number, output: number): string =>
  codexLine('token_usage_record', {
    thread_id: threadId,
    turn_id: turnId,
    response_id: responseId,
    usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: write,
      output_tokens: output,
      reasoning_output_tokens: 3,
      total_tokens: input + output,
    },
  });

const codexTokenCount = (input: number, output: number): string =>
  codexLine('event_msg', {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, total_tokens: input + output } },
  });

const mainMeta = codexLine('session_meta', { id: 'thr-main', cwd: BETA, model_provider: 'openai', source: 'exec' });

const codexMain = [
  mainMeta,
  codexLine('turn_context', { turn_id: 'turn-1', model: 'gpt-5' }),
  codexRecord('thr-main', 'turn-1', 'resp-1', 1000, 600, 0, 50),
  codexRecord('thr-main', 'turn-1', 'resp-2', 2000, 1500, 100, 80),
  codexLine('turn_context', { turn_id: 'turn-2', model: 'gpt-5-codex' }),
  codexRecord('thr-main', 'turn-2', 'resp-3', 500, 0, 0, 20),
  codexRecord('thr-main', 'turn-2', 'resp-3', 500, 0, 0, 20),
  codexRecord('thr-other', 'turn-2', 'resp-foreign', 9000, 0, 0, 9000),
  'not json {',
].join('\n');

const codexSub = [
  codexLine('session_meta', { id: 'thr-sub', cwd: BETA, model_provider: 'openai', source: { subagent: { thread_spawn: {} } } }),
  mainMeta,
  codexLine('turn_context', { turn_id: 'turn-1', model: 'gpt-5' }),
  codexLine('turn_context', { turn_id: 'sub-1', model: 'gpt-5-mini' }),
  codexRecord('thr-sub', 'sub-1', 'resp-s1', 300, 100, 0, 10),
  codexRecord('thr-sub', 'sub-1', 'resp-s2', 50, 0, 0, 5),
].join('\n');

const codexOld = [
  codexLine('session_meta', { id: 'thr-old', cwd: '/work/old', source: 'cli' }),
  codexLine('turn_context', { turn_id: 'turn-1', model: 'gpt-5' }),
  codexTokenCount(80, 20),
  codexTokenCount(80, 20),
  codexTokenCount(200, 50),
].join('\n');

const codexRecords = () => [...recordsFromCodexRollout(codexMain, 'rollout-main'), ...recordsFromCodexRollout(codexSub, 'rollout-sub')];

describe('codex rollouts', () => {
  it('splits tokens per model and moves cached input to cache read', () => {
    const summary = summarizeUsage(recordsFromCodexRollout(codexMain, 'rollout-main'));
    expect(summary.agents.map((a) => a.agent)).toEqual([BETA]);
    expect(summary.agents[0]!.models).toEqual([
      { provider: 'openai', model: 'gpt-5', input: 800, output: 130, cacheRead: 2100, cacheWrite: 100, messages: 2, total: 3130 },
      { provider: 'openai', model: 'gpt-5-codex', input: 500, output: 20, cacheRead: 0, cacheWrite: 0, messages: 1, total: 520 },
    ]);
    expect(summary.total).toBe(3000 + 500 + 130 + 20);
    expect(summary.messages).toBe(3);
  });

  it('counts a repeated response id once and skips a foreign thread', () => {
    const parsed = recordsFromCodexRollout(codexMain, 'rollout-main');
    expect(parsed).toHaveLength(4);
    const summary = summarizeUsage(parsed);
    expect(summary.messages).toBe(3);
    expect(summary.total).toBe(3650);
  });

  it('files sub-agent usage under its own line with its own model', () => {
    const summary = summarizeUsage(codexRecords());
    expect(summary.agents.map((a) => a.agent)).toEqual([BETA, `${BETA} (sub-agents)`]);
    const sub = summary.agents[1]!;
    expect(sub.models).toEqual([{ provider: 'openai', model: 'gpt-5-mini', input: 250, output: 15, cacheRead: 100, cacheWrite: 0, messages: 2, total: 365 }]);
    expect(summary.total).toBe(3650 + 300 + 50 + 10 + 5);
  });

  it('uses the fallback agent and the model provider heuristic without a session_meta', () => {
    const text = [codexLine('turn_context', { turn_id: 't', model: 'gpt-5' }), codexRecord('x', 't', 'r', 10, 4, 0, 2)].join('\n');
    expect(recordsFromCodexRollout(text, 'rollout-x')).toEqual([
      { agent: 'rollout-x', provider: 'openai', model: 'gpt-5', input: 6, output: 2, cacheRead: 4, cacheWrite: 0, id: 'r' },
    ]);
  });

  it('diffs running token_count totals when a rollout has no token_usage_record', () => {
    const parsed = recordsFromCodexRollout(codexOld, 'rollout-old');
    expect(parsed).toHaveLength(2);
    expect(parsed.map((r) => r.input + r.output)).toEqual([100, 150]);
    const summary = summarizeUsage(parsed);
    expect(summary.agents.map((a) => [a.agent, a.total])).toEqual([['/work/old', 250]]);
    expect(summary.models[0]).toMatchObject({ provider: 'openai', model: 'gpt-5', messages: 2, input: 200, output: 50 });
  });
});

describe('claude and codex together', () => {
  const claudeBeta = () => recordsFromTranscript(assistant('msg_c', 'claude-opus-5-5', { input: 100, output: 50, read: 2000, write: 400 }, { cwd: BETA }), 'x');

  it('puts both providers under the same agent', () => {
    const summary = summarizeUsage([...claudeBeta(), ...recordsFromCodexRollout(codexMain, 'x')]);
    expect(summary.agents.map((a) => a.agent)).toEqual([BETA]);
    expect(summary.agents[0]!.models.map((m) => [m.provider, m.model])).toEqual([
      ['anthropic', 'claude-opus-5-5'],
      ['openai', 'gpt-5'],
      ['openai', 'gpt-5-codex'],
    ]);
    expect(summary.total).toBe(2550 + 3650);
  });

  it('gives identical output whatever order the records come in', () => {
    const all = [...claudeBeta(), ...codexRecords(), ...recordsFromCodexRollout(codexOld, 'old')];
    const forward = summarizeUsage(all);
    const reversed = summarizeUsage([...all].reverse());
    const rotated = summarizeUsage([...all.slice(3), ...all.slice(0, 3)]);
    for (const other of [reversed, rotated]) {
      expect(formatUsageSummary(other)).toBe(formatUsageSummary(forward));
      expect(usageSummaryJson(other)).toBe(usageSummaryJson(forward));
    }
  });
});

describe('usage source folders', () => {
  it('reads the folders from the environment', () => {
    expect(defaultCodexDir({ CODEX_HOME: '/x' })).toBe('/x/sessions');
    expect(defaultClaudeDir({ CLAUDE_CONFIG_DIR: '/y' })).toBe('/y/projects');
    expect(defaultCodexDir({})).toBe(path.join(os.homedir(), '.codex', 'sessions'));
    expect(defaultClaudeDir({})).toBe(path.join(os.homedir(), '.claude', 'projects'));
  });
});

describe('usage summary script with codex', () => {
  const setup = (): { tmp: string; claude: string; codex: string } => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'usage-report-'));
    const claude = path.join(tmp, 'claude');
    const codex = path.join(tmp, 'codex');
    mkdirSync(path.join(claude, '-work-alpha'), { recursive: true });
    mkdirSync(path.join(codex, '2026', '11', '10'), { recursive: true });
    writeFileSync(path.join(claude, '-work-alpha', 'session-1.jsonl'), alphaTranscript);
    writeFileSync(path.join(codex, '2026', '11', '10', 'rollout-main.jsonl'), codexMain);
    writeFileSync(path.join(codex, '2026', '11', '10', 'rollout-sub.jsonl'), codexSub);
    return { tmp, claude, codex };
  };

  const run = (...flags: string[]): string => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/usage-summary.ts', ...flags], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  type Json = { total: number; models: { provider: string; model: string }[] };

  it('reads both folders and prints the same thing every time', () => {
    const { tmp, claude, codex } = setup();
    try {
      const first = run('--claude-dir', claude, '--codex-dir', codex, '--json');
      expect(run('--claude-dir', claude, '--codex-dir', codex, '--json')).toBe(first);
      const json = JSON.parse(first) as Json;
      expect(json.total).toBe(1760 + 360 + 3650 + 365);
      expect(json.models.map((m) => m.provider)).toContain('anthropic');
      expect(json.models.map((m) => m.provider)).toContain('openai');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads only the codex folder when only that one is named', () => {
    const { tmp, codex } = setup();
    try {
      const json = JSON.parse(run('--codex-dir', codex, '--json')) as Json;
      expect(json.total).toBe(3650 + 365);
      expect(json.models.some((m) => m.provider === 'anthropic')).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails when a folder flag has no value', () => {
    expect(() => run('--claude-dir')).toThrow();
  });
});
