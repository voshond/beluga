import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SuccessDefineRequest } from '../../agent/success-definer.js';
import type { TileInput } from '../sentinel/dashboards.js';
import type { ScheduleTrigger, SentinelDraft, StepDraft } from '../sentinel/model.js';
import { addTimeline, folderOf, writeText } from './files.js';
import type { InitiativeStatus, InitiativeView } from './model.js';
import type { LinkedRepo } from './prompt.js';
import { dayOf } from './repo.js';
import {
  type BeforeSince,
  type KeptPoint,
  SUCCESS_FILE,
  type SuccessDefinition,
  type SuccessDraft,
  type SuccessFile,
  SuccessFileSchema,
  type SuccessMetric,
  type SuccessPreview,
  type SuccessProposal,
  type SuccessProposalInput,
  SuccessProposalSchema,
  type SuccessSource,
  beforeSince,
  keptNames,
  keptQuery,
  looksSecret,
  scopeChange,
  valueOf,
} from './success.js';
import { successBrief } from './success-prompt.js';

export type SuccessRows = { readonly columns: readonly string[]; readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>> };

/** What success needs from Sentinel: run a query read-only, keep the numbers, draw them. Throws on a query that fails. */
export type SuccessHost = {
  readonly peek: (source: SuccessSource, project?: string) => Promise<SuccessRows>;
  readonly sentinelExists: (id: string) => boolean;
  readonly createSentinel: (draft: SentinelDraft) => { readonly id: string };
  readonly updateSentinel: (id: string, name: string, steps: readonly StepDraft[], projectId: string | null) => void;
  readonly pauseSentinel: (id: string) => void;
  /** Fills that dashboard with these tiles (made when it's gone) → its id. */
  readonly putDashboard: (id: string | undefined, name: string, tiles: readonly TileInput[]) => string;
  readonly points: (sentinelId: string, name: string) => readonly KeptPoint[];
};

export type SuccessDeps = {
  readonly root: string;
  readonly host: () => SuccessHost | undefined;
  readonly propose?: (req: SuccessDefineRequest) => Promise<SuccessProposal | undefined>;
  readonly now: () => number;
};

const ROWS_SHOWN = 20;

const SUCCESS_TRIGGER: ScheduleTrigger = { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' };

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error: /, '');

/** One Keep the numbers step per metric: the value, with its baseline and target beside it. */
export const measureStep = (m: SuccessMetric, baseline: number): StepDraft => {
  const n = keptNames(m.name);
  return {
    kind: 'measure',
    name: m.label,
    from: 'source',
    source: { ...m.source, query: keptQuery(m, baseline) },
    metrics: [
      { name: n.value, label: m.label, pick: 'value', unit: m.unit, better: m.direction },
      { name: n.baseline, label: `${m.label}: baseline`, pick: 'baseline', unit: m.unit, better: 'none' },
      { name: n.target, label: `${m.label}: target`, pick: 'target', unit: m.unit, better: 'none' },
    ],
  };
};

/** Per metric, its number now and its baseline and target beside it, then the three over time. */
export const successTiles = (sentinelId: string, metrics: readonly SuccessMetric[]): TileInput[] =>
  metrics.flatMap((m): TileInput[] => {
    const n = keptNames(m.name);
    const ref = (metric: string) => ({ sentinelId, metric });
    return [
      { kind: 'number', width: 2, metric: ref(n.value), title: m.label },
      { kind: 'number', width: 2, metric: ref(n.baseline), title: `${m.label}: baseline` },
      { kind: 'number', width: 2, metric: ref(n.target), title: `${m.label}: target` },
      { kind: 'series', width: 6, chart: 'line', metrics: [ref(n.value), ref(n.baseline), ref(n.target)], title: `${m.label} over time` },
    ];
  });

const describeRows = (got: SuccessRows): string => {
  if (!got.rows.length) return `No rows came back (columns: ${got.columns.join(', ') || 'none'}).`;
  return `${got.rows.length} row${got.rows.length === 1 ? '' : 's'}, columns ${got.columns.join(', ')}:\n${got.rows
    .slice(0, ROWS_SHOWN)
    .map((r) => JSON.stringify(r))
    .join('\n')}`;
};

export class InitiativeSuccess {
  constructor(private readonly deps: SuccessDeps) {}

  private file(slug: string): string {
    return path.join(folderOf(this.deps.root, slug), SUCCESS_FILE);
  }

  read(slug: string): SuccessFile {
    try {
      const parsed = SuccessFileSchema.safeParse(JSON.parse(readFileSync(this.file(slug), 'utf8')));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  private write(slug: string, file: SuccessFile): void {
    writeText(this.file(slug), `${JSON.stringify(file, null, 2)}\n`);
  }

  private need(): SuccessHost {
    const host = this.deps.host();
    if (!host) throw new Error('Success needs the Beluga app (its Sentinel)');
    return host;
  }

  /** The agent's pass, then each query run once: its first rows, and the baseline from the window before delivery. */
  async draft(item: InitiativeView, repos: readonly LinkedRepo[]): Promise<SuccessDraft> {
    const host = this.need();
    if (!this.deps.propose) throw new Error('Defining success needs an agent on this computer');
    const shippedAt = this.read(item.slug).shippedAt;
    const proposal = await this.deps
      .propose({
        name: item.name,
        goal: item.goal,
        status: item.status,
        ...(shippedAt ? { shippedAt } : {}),
        tickets: (item.tickets?.tickets ?? []).map((t) => ({ key: t.key, summary: t.summary, status: t.status })),
        repos,
        trySource: async (source, project) => {
          try {
            return describeRows(await host.peek(source, project));
          } catch (err) {
            throw new Error(`It failed: ${why(err)}`);
          }
        },
      })
      .catch(() => undefined);
    if (!proposal) throw new Error('Your agent could not propose a definition just now. Try again.');
    const previews: SuccessPreview[] = [];
    const metrics: SuccessMetric[] = [];
    for (const m of proposal.metrics) {
      const preview = await this.preview(host, m, proposal.project);
      previews.push(preview);
      metrics.push(m.baseline === undefined && preview.baseline !== undefined ? { ...m, baseline: preview.baseline } : m);
    }
    return { proposal: { ...proposal, metrics }, previews };
  }

  private async preview(host: SuccessHost, m: SuccessMetric, project: string | undefined): Promise<SuccessPreview> {
    try {
      const got = await host.peek(m.source, project);
      const value = valueOf(got.rows);
      const baseline = await host
        .peek({ ...m.source, query: m.baselineQuery }, project)
        .then((b) => valueOf(b.rows))
        .catch(() => undefined);
      return { metric: m.name, columns: got.columns, rows: got.rows.slice(0, ROWS_SHOWN), ...(value !== undefined ? { value } : {}), ...(baseline !== undefined ? { baseline } : {}) };
    } catch (err) {
      return { metric: m.name, columns: [], rows: [], error: why(err) };
    }
  }

  /**
   * The owner accepts (maybe after changing it): every query runs once more, as it will be kept,
   * and nothing is saved when one fails. Then its sentinel (paused when new) and its dashboard.
   */
  async accept(item: InitiativeView, input: SuccessProposalInput): Promise<SuccessDefinition> {
    const host = this.need();
    const proposal = SuccessProposalSchema.parse(input);
    if (proposal.metrics.some((m) => looksSecret(`${m.source.query}\n${m.baselineQuery}\n${m.filter}`))) throw new Error('A query looks like it carries a connection string or a key: take it out. Sources use the project’s own variables.');
    const metrics: SuccessMetric[] = [];
    for (const m of proposal.metrics) {
      const baselineRows = await host.peek({ ...m.source, query: m.baselineQuery }, proposal.project).catch((err: unknown) => {
        throw new Error(`“${m.label}”: its baseline query did not run, so nothing was saved: ${why(err)}`);
      });
      const baseline = m.baseline ?? valueOf(baselineRows.rows);
      if (baseline === undefined) throw new Error(`“${m.label}”: its baseline query gave no number in a value column, so nothing was saved`);
      const kept = await host.peek({ ...m.source, query: keptQuery(m, baseline) }, proposal.project).catch((err: unknown) => {
        throw new Error(`“${m.label}”: its query did not run, so nothing was saved: ${why(err)}`);
      });
      if (valueOf(kept.rows) === undefined) throw new Error(`“${m.label}”: its query gave no number in a value column, so nothing was saved`);
      metrics.push({ ...m, baseline });
    }
    const was = this.read(item.slug);
    const name = `${item.name} success`.slice(0, 80);
    const steps = metrics.map((m) => measureStep(m, m.baseline!));
    const existing = was.definition?.sentinel && host.sentinelExists(was.definition.sentinel) ? was.definition.sentinel : undefined;
    if (existing) host.updateSentinel(existing, name, steps, proposal.project ?? null);
    const sentinel = existing ?? host.createSentinel({ name, icon: 'gauge', projectId: proposal.project ?? null, trigger: SUCCESS_TRIGGER, steps, access: 'look' }).id;
    if (item.status === 'archived') host.pauseSentinel(sentinel);
    const dashboard = host.putDashboard(was.definition?.dashboard, `${item.name} outcome`.slice(0, 60), successTiles(sentinel, metrics));
    const definition: SuccessDefinition = { ...proposal, metrics, at: new Date(this.deps.now()).toISOString(), sentinel, dashboard, ...(item.tickets ? { scope: item.tickets.tickets.map((t) => t.key) } : {}) };
    this.write(item.slug, { ...was, definition });
    addTimeline(this.deps.root, item.slug, `${dayOf(this.deps.now())} [decision]: success defined: ${metrics.map((m) => m.label).join(', ')}`);
    return definition;
  }

  /** Shipped notes the day (cleared when it moves back); archived pauses the sentinel, keeping its numbers and dashboard. */
  statusChanged(slug: string, was: InitiativeStatus, next: InitiativeStatus): boolean {
    const file = this.read(slug);
    if (next === 'archived' && file.definition?.sentinel) {
      const host = this.deps.host();
      if (host?.sentinelExists(file.definition.sentinel)) host.pauseSentinel(file.definition.sentinel);
    }
    if (next === 'shipped' && was !== 'shipped') {
      this.write(slug, { ...file, shippedAt: new Date(this.deps.now()).toISOString() });
      return true;
    }
    if (was === 'shipped' && (next === 'active' || next === 'paused') && file.shippedAt) {
      const { shippedAt: _gone, ...rest } = file;
      this.write(slug, rest);
      return true;
    }
    return false;
  }

  numbers(file: SuccessFile): Record<string, BeforeSince> {
    const def = file.definition;
    const host = this.deps.host();
    if (!def?.sentinel || !host) return {};
    const shipped = file.shippedAt ? Date.parse(file.shippedAt) : NaN;
    return Object.fromEntries(def.metrics.map((m) => [m.name, beforeSince(host.points(def.sentinel!, keptNames(m.name).value), Number.isFinite(shipped) ? shipped : undefined, m.baseline)]));
  }

  brief(item: InitiativeView, checkIn: boolean): string {
    const file = this.read(item.slug);
    const keys = (item.tickets?.tickets ?? []).map((t) => t.key);
    return successBrief(file, this.numbers(file), file.definition && item.tickets ? scopeChange(file.definition.scope, keys) : undefined, checkIn);
  }
}
