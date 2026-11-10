import { z } from 'zod';

export type TokenCounts = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

export type UsageRecord = TokenCounts & {
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly id?: string;
};

export type ModelUsage = TokenCounts & {
  readonly provider: string;
  readonly model: string;
  readonly messages: number;
  readonly total: number;
};

export type AgentUsage = TokenCounts & {
  readonly agent: string;
  readonly models: readonly ModelUsage[];
  readonly messages: number;
  readonly total: number;
};

export type UsageSummary = TokenCounts & {
  readonly agents: readonly AgentUsage[];
  readonly models: readonly ModelUsage[];
  readonly messages: number;
  readonly total: number;
};

const ZERO_COUNTS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const SUB_AGENTS = ' (sub-agents)';

const count = z.number().finite().nonnegative().catch(0).default(0);

const TranscriptLine = z.object({
  type: z.string().optional(),
  cwd: z.string().optional(),
  isSidechain: z.boolean().optional(),
  message: z
    .object({
      id: z.string().optional(),
      model: z.string().optional(),
      usage: z
        .object({
          input_tokens: count,
          output_tokens: count,
          cache_read_input_tokens: count,
          cache_creation_input_tokens: count,
        })
        .optional(),
    })
    .optional(),
});

const CodexTokens = z.object({
  input_tokens: count,
  cached_input_tokens: count,
  cache_write_input_tokens: count,
  output_tokens: count,
});

const CodexLine = z.object({
  type: z.string().optional(),
  payload: z
    .object({
      type: z.string().optional(),
      id: z.string().optional(),
      cwd: z.string().optional(),
      model: z.string().optional(),
      model_provider: z.string().optional(),
      turn_id: z.string().optional(),
      thread_id: z.string().optional(),
      response_id: z.string().optional(),
      source: z.union([z.string(), z.object({ subagent: z.object({}).optional() })]).optional().catch(undefined),
      usage: CodexTokens.optional(),
      info: z.object({ total_token_usage: CodexTokens.optional() }).nullable().optional(),
    })
    .optional(),
});

type CodexTokenUsage = z.infer<typeof CodexTokens>;

const MODEL_PROVIDERS: readonly (readonly [RegExp, string])[] = [
  [/^(claude|anthropic)/i, 'anthropic'],
  [/^(gpt|o\d|codex|chatgpt)/i, 'openai'],
  [/^gemini/i, 'google'],
  [/^(mistral|codestral|devstral)/i, 'mistral'],
  [/^(llama|qwen|deepseek|phi|gemma)/i, 'local'],
];

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sumOf = (c: TokenCounts): number => c.input + c.output + c.cacheRead + c.cacheWrite;

const addCounts = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

const maxCounts = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: Math.max(a.input, b.input),
  output: Math.max(a.output, b.output),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
});

const countsOf = (c: TokenCounts): TokenCounts => ({ input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite });

export const providerOfModel = (model: string): string => {
  const slash = model.indexOf('/');
  if (slash > 0) return model.slice(0, slash).toLowerCase();
  const match = MODEL_PROVIDERS.find(([pattern]) => pattern.test(model));
  return match ? match[1] : 'unknown';
};

const parseLines = <T extends z.ZodTypeAny>(text: string, schema: T): z.infer<T>[] =>
  text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });

export const recordsFromTranscript = (text: string, fallbackAgent: string): UsageRecord[] => {
  const records: UsageRecord[] = [];
  for (const entry of parseLines(text, TranscriptLine)) {
    const message = entry.message;
    if (entry.type !== 'assistant' || !message?.usage || !message.model || message.model === '<synthetic>') continue;
    const base = entry.cwd || fallbackAgent;
    const usage = message.usage;
    records.push({
      agent: entry.isSidechain ? `${base}${SUB_AGENTS}` : base,
      provider: providerOfModel(message.model),
      model: message.model,
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      ...(message.id ? { id: message.id } : {}),
    });
  }
  return records;
};

const fromCodexTokens = (u: CodexTokenUsage): TokenCounts => ({
  input: Math.max(0, u.input_tokens - u.cached_input_tokens - u.cache_write_input_tokens),
  output: u.output_tokens,
  cacheRead: u.cached_input_tokens,
  cacheWrite: u.cache_write_input_tokens,
});

const minusCounts = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: Math.max(0, a.input - b.input),
  output: Math.max(0, a.output - b.output),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
});

export const recordsFromCodexRollout = (text: string, fallbackAgent: string): UsageRecord[] => {
  const lines = parseLines(text, CodexLine);
  const meta = lines.find((l) => l.type === 'session_meta')?.payload;
  const base = meta?.cwd || fallbackAgent;
  const agent = typeof meta?.source === 'object' && meta.source.subagent ? `${base}${SUB_AGENTS}` : base;
  const providerFor = (model: string): string => meta?.model_provider || providerOfModel(model);
  const modelOfTurn = new Map<string, string>();
  const records: UsageRecord[] = [];
  const hasRecords = lines.some((l) => l.type === 'token_usage_record');
  let model = 'unknown';
  let lastTotal = ZERO_COUNTS;
  for (const { type, payload } of lines) {
    if (!payload) continue;
    if (type === 'turn_context' && payload.model) {
      model = payload.model;
      if (payload.turn_id) modelOfTurn.set(payload.turn_id, payload.model);
      continue;
    }
    if (hasRecords && type === 'token_usage_record' && payload.usage) {
      if (meta?.id && payload.thread_id && payload.thread_id !== meta.id) continue;
      const used = (payload.turn_id && modelOfTurn.get(payload.turn_id)) || model;
      records.push({ agent, provider: providerFor(used), model: used, ...fromCodexTokens(payload.usage), ...(payload.response_id ? { id: payload.response_id } : {}) });
      continue;
    }
    const total = payload.type === 'token_count' ? payload.info?.total_token_usage : undefined;
    if (hasRecords || !total) continue;
    const counts = fromCodexTokens(total);
    const delta = minusCounts(counts, lastTotal);
    lastTotal = counts;
    if (sumOf(delta) > 0) records.push({ agent, provider: providerFor(model), model, ...delta });
  }
  return records;
};

const labelOrder = (a: UsageRecord, b: UsageRecord): number => compare(a.agent, b.agent) || compare(a.provider, b.provider) || compare(a.model, b.model);

const dedupe = (records: readonly UsageRecord[]): UsageRecord[] => {
  const byId = new Map<string, UsageRecord>();
  const rest: UsageRecord[] = [];
  for (const record of records) {
    if (!record.id) {
      rest.push(record);
      continue;
    }
    const seen = byId.get(record.id);
    if (!seen) {
      byId.set(record.id, record);
      continue;
    }
    const label = labelOrder(record, seen) < 0 ? record : seen;
    byId.set(record.id, { ...label, ...maxCounts(seen, record) });
  }
  return [...byId.values(), ...rest];
};

const modelKey = (r: { readonly provider: string; readonly model: string }): string => `${r.provider}\u0000${r.model}`;

const groupModels = (records: readonly UsageRecord[]): ModelUsage[] => {
  const groups = new Map<string, { provider: string; model: string; counts: TokenCounts; messages: number }>();
  for (const record of records) {
    const key = modelKey(record);
    const group = groups.get(key) ?? { provider: record.provider, model: record.model, counts: ZERO_COUNTS, messages: 0 };
    groups.set(key, { ...group, counts: addCounts(group.counts, countsOf(record)), messages: group.messages + 1 });
  }
  return [...groups.values()]
    .map((g) => ({ provider: g.provider, model: g.model, ...g.counts, messages: g.messages, total: sumOf(g.counts) }))
    .sort((a, b) => compare(a.provider, b.provider) || compare(a.model, b.model));
};

const totalOf = (models: readonly ModelUsage[]): TokenCounts & { readonly messages: number; readonly total: number } => {
  const counts = models.reduce<TokenCounts>((acc, m) => addCounts(acc, countsOf(m)), ZERO_COUNTS);
  return { ...counts, messages: models.reduce((n, m) => n + m.messages, 0), total: sumOf(counts) };
};

export const summarizeUsage = (records: readonly UsageRecord[]): UsageSummary => {
  const unique = dedupe(records);
  const byAgent = new Map<string, UsageRecord[]>();
  for (const record of unique) byAgent.set(record.agent, [...(byAgent.get(record.agent) ?? []), record]);
  const agents = [...byAgent.entries()]
    .map(([agent, rows]) => {
      const models = groupModels(rows);
      return { agent, models, ...totalOf(models) };
    })
    .sort((a, b) => compare(a.agent, b.agent));
  const models = groupModels(unique);
  return { agents, models, ...totalOf(models) };
};

const grouped = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const HEADERS = ['Provider', 'Model', 'Messages', 'Input', 'Output', 'Cache read', 'Cache write', 'Total'] as const;

const rowOf = (provider: string, model: string, u: TokenCounts & { readonly messages: number; readonly total: number }): string[] => [
  provider,
  model,
  grouped(u.messages),
  grouped(u.input),
  grouped(u.output),
  grouped(u.cacheRead),
  grouped(u.cacheWrite),
  grouped(u.total),
];

const table = (rows: readonly string[][]): string[] => {
  const header: readonly string[] = HEADERS;
  const widths = header.map((_, i) => Math.max(...[header, ...rows].map((r) => (r[i] ?? '').length)));
  const line = (r: readonly string[]): string =>
    r
      .map((cell, i) => (i < 2 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)];
};

export const formatUsageSummary = (summary: UsageSummary): string => {
  if (!summary.agents.length) return 'No recorded agent usage found.\n';
  const out: string[] = [
    `Agent usage: ${summary.agents.length} agent${summary.agents.length === 1 ? '' : 's'}, ${summary.models.length} model${summary.models.length === 1 ? '' : 's'}, ${grouped(summary.total)} tokens`,
    'Total = input + output + cache read + cache write.',
  ];
  for (const agent of summary.agents) {
    out.push('', `${agent.agent}  (${grouped(agent.total)} tokens)`, ...table(agent.models.map((m) => rowOf(m.provider, m.model, m))).map((l) => `  ${l}`));
  }
  out.push('', 'All agents', ...table([...summary.models.map((m) => rowOf(m.provider, m.model, m)), rowOf('all', '', summary)]).map((l) => `  ${l}`));
  return `${out.join('\n')}\n`;
};

export const usageSummaryJson = (summary: UsageSummary): string => `${JSON.stringify(summary, null, 2)}\n`;
