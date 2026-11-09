import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, safeName, writeJson } from '../../net/mesh/files.js';
import { KEEP_MS, KEEP_POINTS, type MetricLine, prunePoints, readLine } from './metrics.js';
import type { MetricColumn } from './columns.js';
import type { Better, MetricKind, MetricUnit } from './model.js';

/**
 * Where numbers live (docs/sentinel.md §10): ~/.beluga/sentinel/metrics/<sentinelId>/<name>.jsonl,
 * one line per run (`{ at, value | series | rows | output, runId }`), readable only by you, kept to
 * two years or 20 000 points (an output metric its last 30); what each metric is (its label, unit, which way is good) beside them in
 * meta.json. Without a folder (tests, the demo) everything stays in memory.
 */

export interface MetricMeta {
  readonly label: string;
  readonly unit: MetricUnit;
  readonly better: Better;
  readonly kind: MetricKind;
  /** A rows metric's typed columns (a document's cell is its file's name in its run's folder). */
  readonly columnTypes?: readonly MetricColumn[];
}

/** How many lines a file may grow past its limit before it's rewritten (so pruning isn't every run). */
const SLACK = 200;

export class MetricFiles {
  private readonly memory = new Map<string, Map<string, MetricLine[]>>();
  private readonly metas = new Map<string, Record<string, MetricMeta>>();
  /** Lines per file as last read or written (to know when it's due a prune). */
  private readonly counts = new Map<string, { n: number; oldest: number }>();
  /** Files whose last line was cut off (Beluga closed while writing): the next line starts on its own. */
  private readonly torn = new Set<string>();

  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** ~/.beluga/sentinel/metrics (none in memory). */
  get root(): string | undefined {
    return this.dir ? path.join(this.dir, 'sentinel', 'metrics') : undefined;
  }

  private folder(sentinelId: string): string | undefined {
    return this.root ? path.join(this.root, safeName(sentinelId)) : undefined;
  }

  private fileOf(sentinelId: string, name: string): string | undefined {
    const dir = this.folder(sentinelId);
    return dir ? path.join(dir, `${safeName(name)}.jsonl`) : undefined;
  }

  /** The sentinels that have numbers, and each one's metric names (from the files, or memory). */
  list(): Array<{ readonly sentinelId: string; readonly names: string[] }> {
    const root = this.root;
    if (!root) return [...this.memory].map(([sentinelId, m]) => ({ sentinelId, names: [...m.keys()] }));
    let ids: string[];
    try {
      ids = readdirSync(root);
    } catch {
      return [];
    }
    return ids.flatMap((sentinelId) => {
      try {
        const names = readdirSync(path.join(root, sentinelId))
          .filter((n) => n.endsWith('.jsonl'))
          .map((n) => n.slice(0, -'.jsonl'.length));
        return names.length ? [{ sentinelId, names }] : [];
      } catch {
        return [];
      }
    });
  }

  meta(sentinelId: string): Readonly<Record<string, MetricMeta>> {
    const had = this.metas.get(sentinelId);
    if (had) return had;
    const dir = this.folder(sentinelId);
    const read = dir ? (readJson(path.join(dir, 'meta.json')) as Record<string, MetricMeta> | undefined) : undefined;
    const meta = read && typeof read === 'object' ? read : {};
    this.metas.set(sentinelId, meta);
    return meta;
  }

  setMeta(sentinelId: string, name: string, meta: MetricMeta): void {
    const was = this.meta(sentinelId);
    if (JSON.stringify(was[name]) === JSON.stringify(meta)) return;
    const next = { ...was, [name]: meta };
    this.metas.set(sentinelId, next);
    const dir = this.folder(sentinelId);
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeJson(path.join(dir, 'meta.json'), next);
    } catch {
      // Kept for this run of Beluga; the next point tries again.
    }
  }

  /** Every line of a metric, oldest first (those since `since`, when given). */
  read(sentinelId: string, name: string, since?: number): MetricLine[] {
    const file = this.fileOf(sentinelId, name);
    let lines: MetricLine[];
    if (!file) lines = this.memory.get(sentinelId)?.get(name) ?? [];
    else {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return [];
      }
      lines = text.split('\n').flatMap((l) => (l.trim() ? (readLine(l) ?? []) : []));
      this.counts.set(file, { n: lines.length, oldest: lines[0]?.at ?? this.now() });
      if (text && !text.endsWith('\n')) this.torn.add(file);
      else this.torn.delete(file);
    }
    return since === undefined ? [...lines] : lines.filter((l) => l.at >= since);
  }

  /** A run's point, added; the file is pruned (two years, 20 000 points) once it's grown past that. */
  append(sentinelId: string, name: string, line: MetricLine, keep = KEEP_POINTS): void {
    const file = this.fileOf(sentinelId, name);
    if (!file) {
      const m = this.memory.get(sentinelId) ?? new Map<string, MetricLine[]>();
      m.set(name, prunePoints([...(m.get(name) ?? []), line], this.now(), keep));
      this.memory.set(sentinelId, m);
      return;
    }
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (!this.counts.has(file) && existsSync(file)) this.read(sentinelId, name);
      appendFileSync(file, `${this.torn.has(file) ? '\n' : ''}${JSON.stringify(line)}\n`, { mode: 0o600 });
      this.torn.delete(file);
      const c = this.counts.get(file) ?? { n: 0, oldest: line.at };
      const next = { n: c.n + 1, oldest: Math.min(c.oldest, line.at) };
      this.counts.set(file, next);
      if (next.n > keep + Math.min(SLACK, keep) || next.oldest < this.now() - KEEP_MS - 24 * 60 * 60_000) this.prune(sentinelId, name, keep);
    } catch {
      // A full disk: this point isn't kept, the state still shows it.
    }
  }

  /** Rewrite a metric's file with what's kept (atomically: a new file, then renamed over). */
  prune(sentinelId: string, name: string, keep = KEEP_POINTS): void {
    const file = this.fileOf(sentinelId, name);
    if (!file) return;
    const kept = prunePoints(this.read(sentinelId, name), this.now(), keep);
    try {
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, kept.map((l) => `${JSON.stringify(l)}\n`).join(''), { mode: 0o600 });
      // Renamed over the old one: a reader never sees half a file.
      renameSync(tmp, file);
      this.counts.set(file, { n: kept.length, oldest: kept[0]?.at ?? this.now() });
    } catch {
      // Kept as it was: the next point tries again.
    }
  }

  /** A metric's whole history, written at once (its sentinel moved here from another computer, BLG-807). */
  putAll(sentinelId: string, name: string, lines: readonly MetricLine[]): void {
    const kept = prunePoints([...lines].sort((a, b) => a.at - b.at), this.now(), KEEP_POINTS);
    const file = this.fileOf(sentinelId, name);
    if (!file) {
      const m = this.memory.get(sentinelId) ?? new Map<string, MetricLine[]>();
      m.set(name, kept);
      this.memory.set(sentinelId, m);
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, kept.map((l) => `${JSON.stringify(l)}\n`).join(''), { mode: 0o600 });
    renameSync(tmp, file);
    this.counts.set(file, { n: kept.length, oldest: kept[0]?.at ?? this.now() });
    this.torn.delete(file);
  }

  /** A deleted sentinel's numbers go with it. */
  remove(sentinelId: string): void {
    this.memory.delete(sentinelId);
    this.metas.delete(sentinelId);
    const dir = this.folder(sentinelId);
    if (!dir) return;
    for (const key of [...this.counts.keys()]) if (key.startsWith(`${dir}${path.sep}`)) this.counts.delete(key);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Not ours to remove, or gone already.
    }
  }
}
