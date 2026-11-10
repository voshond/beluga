import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunRouting, RunSubagent } from '../../types.js';
import type { Model } from './protocol.js';
import { clampEffort, smallCodexModel } from './runner.js';

const LARGE_MODEL = /\b(frontier|most capable|most demanding|max|pro)\b/i;

export const largeCodexModel = (models: readonly Model[]): string | undefined =>
  models.find((m) => !m.hidden && !m.isDefault && LARGE_MODEL.test(`${m.id} ${m.displayName} ${m.description}`))?.id;

const defaultCodexModel = (models: readonly Model[]): string | undefined => models.find((m) => m.isDefault)?.id;

export const codexTierModel = (tier: string | undefined, models: readonly Model[]): string | undefined => {
  if (!tier) return undefined;
  if (/haiku/i.test(tier)) return smallCodexModel(models) ?? defaultCodexModel(models);
  if (/opus/i.test(tier)) return largeCodexModel(models) ?? defaultCodexModel(models);
  if (/sonnet/i.test(tier)) return defaultCodexModel(models);
  return undefined;
};

const tomlString = (text: string): string => JSON.stringify(text);

export const roleToml = (worker: RunSubagent, models: readonly Model[]): string => {
  const model = codexTierModel(worker.model, models);
  const supported = models.find((m) => m.id === model)?.supportedReasoningEfforts.map((e) => e.reasoningEffort);
  const effort = worker.effort ? clampEffort(worker.effort, supported) : undefined;
  return [model ? `model = ${tomlString(model)}` : '', effort ? `model_reasoning_effort = ${tomlString(effort)}` : '', `developer_instructions = ${tomlString(worker.prompt)}`].filter(Boolean).join('\n') + '\n';
};

export const codexRoleConfig = async (routing: RunRouting, models: readonly Model[], dir: string): Promise<Record<string, { readonly description: string; readonly config_file: string }>> => {
  await mkdir(dir, { recursive: true });
  const entries = await Promise.all(
    Object.entries(routing.agents).map(async ([name, worker]) => {
      const text = roleToml(worker, models);
      const file = path.join(dir, `${name}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.toml`);
      await writeFile(file, text);
      return [`agents.${name}`, { description: worker.description, config_file: file }] as const;
    }),
  );
  return Object.fromEntries(entries);
};
