import { execFile } from 'node:child_process';
import { codexCommand } from '../codex/app-server.js';

/** A model as the picker shows it (value `provider/model`, the efforts it takes). */
export interface OpenCodeModelChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly efforts?: readonly string[];
}

/** Beluga's effort names, as OpenCode calls a model's variants of the same names. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

interface VerboseModel {
  readonly id?: string;
  readonly providerID?: string;
  readonly name?: string;
  readonly status?: string;
  readonly variants?: Readonly<Record<string, unknown>>;
  readonly limit?: { readonly context?: number };
}

const tokens = (n: number | undefined): string => (!n ? '' : n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`);

/**
 * `opencode models --verbose` as picker rows: each model under its `provider/model` id, its name,
 * whose it is and how much it holds, and the efforts it takes (its variants Beluga has names for).
 * The output is each model's id on a line, then its JSON.
 */
export function parseModels(out: string): OpenCodeModelChoice[] {
  const rows: OpenCodeModelChoice[] = [];
  for (const part of out.split(/^(?=[\w.@-]+\/\S+\s*\n\{)/m)) {
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    let m: VerboseModel;
    try {
      m = JSON.parse(part.slice(nl + 1)) as VerboseModel;
    } catch {
      continue;
    }
    if (!m.id || !m.providerID || m.status === 'deprecated') continue;
    const efforts = EFFORTS.filter((e) => m.variants && e in m.variants);
    const held = tokens(m.limit?.context);
    rows.push({ value: `${m.providerID}/${m.id}`, label: m.name || m.id, description: [m.providerID, held ? `${held} context` : ''].filter(Boolean).join(' · '), ...(efforts.length ? { efforts } : {}) });
  }
  return rows;
}

const MODELS_TIMEOUT_MS = 20_000;
const CACHE_MS = 60_000;
let cached: { readonly bin: string; readonly at: number; readonly models: Promise<OpenCodeModelChoice[] | undefined> } | undefined;

/** Run `opencode <args>` and give its output (undefined when it failed). */
export function openCode(bin: string, args: readonly string[], timeout = MODELS_TIMEOUT_MS, cwd?: string): Promise<string | undefined> {
  const how = codexCommand(bin, args);
  return new Promise((resolve) => {
    execFile(how.command, [...how.args], { timeout, maxBuffer: 16 * 1024 * 1024, shell: how.shell, windowsHide: true, ...(cwd ? { cwd } : {}) }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

/** The models your OpenCode offers (every provider you've set up, its free ones too); kept a minute. */
export function listOpenCodeModels(bin: string, now = Date.now()): Promise<OpenCodeModelChoice[] | undefined> {
  if (cached && cached.bin === bin && now - cached.at < CACHE_MS) return cached.models;
  const models = openCode(bin, ['models', '--verbose']).then((out) => (out === undefined ? undefined : parseModels(out)));
  cached = { bin, at: now, models };
  return models;
}
