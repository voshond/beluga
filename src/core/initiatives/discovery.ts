import { type Dirent, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { DISCOVERY_TEXT_MAX, DemoSchema, type Discovery, type DiscoveryText, ProposalSchema, SIZING_DIR } from './discovery-model.js';

const readText = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const textOf = (file: string): DiscoveryText | undefined => {
  const text = readText(file)?.trim();
  if (!text) return undefined;
  return { text: text.slice(0, DISCOVERY_TEXT_MAX), cut: text.length > DISCOVERY_TEXT_MAX };
};

type Read<T> = { readonly value?: T; readonly trouble?: string };

const jsonOf = <S extends z.ZodTypeAny>(file: string, schema: S, name: string): Read<z.infer<S>> => {
  const text = readText(file);
  if (text === undefined) return {};
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) return { value: parsed.data };
    const issue = parsed.error.issues[0];
    return { trouble: `${name}: ${issue ? `${issue.path.join('.') || 'the file'} ${issue.message}` : 'not what it should be'}` };
  } catch (err) {
    return { trouble: `${name} is not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
};

/** What an initiative in discovery has worked out so far; undefined for one in delivery. */
export const readDiscovery = (folder: string, status: string): Discovery | undefined => {
  if (status !== 'discovery') return undefined;
  const at = (name: string): string => path.join(folder, name);
  const problem = textOf(at('problem.md'));
  const evidence = textOf(at('evidence.md'));
  const prd = textOf(at('prd.md'));
  const demo = jsonOf(at('demo.json'), DemoSchema, 'demo.json');
  const proposal = jsonOf(at('proposal.json'), ProposalSchema, 'proposal.json');
  const troubles = [demo.trouble, proposal.trouble].filter((t): t is string => Boolean(t));
  return {
    ...(problem ? { problem } : {}),
    ...(evidence ? { evidence } : {}),
    ...(prd ? { prd } : {}),
    ...(demo.value ? { demo: demo.value } : {}),
    ...(proposal.value ? { proposal: proposal.value } : {}),
    ...(troubles.length ? { trouble: troubles.join('; ') } : {}),
  };
};

/** The findings the agent left in sizing/, oldest first: each becomes an artifact. */
export const sizingFiles = (folder: string): string[] => {
  const dir = path.join(folder, SIZING_DIR);
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs || a.localeCompare(b));
};

/** A finding's title: its first heading, or its file name. */
export const findingTitle = (file: string): string => {
  const heading = /^#+\s+(.+)$/m.exec(readText(file) ?? '')?.[1]?.trim();
  return (heading || path.basename(file).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')).slice(0, 200);
};
