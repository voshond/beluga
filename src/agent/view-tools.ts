import { tool, toolSuite } from './tool-kit.js';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { GRAPH_FENCE, parseGraph } from '../shared/graph-spec.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { MAX_SOURCE_ROWS, type Row, type Source, SourceSchema, VIEW_FENCE, type ViewPage, readView, toRows, viewBlock } from '../shared/view-spec.js';
import { initialState, resolveControls } from '../shared/view-controls.js';
import { fetchSource } from '../core/views/sources.js';
import { viewDataDir } from '../core/views/kept.js';
import { planScript, writeScript } from '../core/views/scripts.js';
import { mentionsSecret } from './policy.js';
import { visualToken } from '../shared/term-visuals.js';
import type { TerminalSink } from './types.js';

/**
 * Claude's `show` tool (mcp__beluga_view__show): a table, chart, stat tiles, code, colors, gantt, heatmap, calendar or a
 * graph from JSON, checked, with its source run once here so it comes with its first rows. It
 * goes into the answer where Claude writes its token ([[view:1]]), or at the end; a token Claude
 * made up (no view behind it) is dropped, never shown as text. The window
 * fetches more pages, sorts, searches and refreshes it from then on (shared/view-spec.ts).
 */

export const SHOW_TOOL = 'mcp__beluga_view__show';
/**
 * What an answer's tokens are read from: code (a fenced block, an inline span) is Claude writing
 * about a token, left as it is; else a token, with the blank lines and spaces around it (its block
 * goes on lines of its own: a fence mid-sentence isn't one) and backticks if Claude quoted it.
 */
const PIECES = /^[ \t]*(?<fence>`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\k<fence>[`~]*[ \t]*$|(?![\s\S]))|(?<before>\n*)[ \t]*(?<tick>`?)\[\[view:(?<n>\d+)\]\]\k<tick>[ \t]*:?(?<after>\n*)|(?<span>`+)(?!`)[^\n]*?(?<!`)\k<span>(?!`)/gm;
/** Rows a view carries in the answer (what everyone sees before, or without, fetching). */
const SNAPSHOT_ROWS = { table: 50, chart: 500, stats: 50, colors: 64, code: 0, gantt: 200, heatmap: 500, calendar: 500 } as const;

/** The views a run showed, and where they go in its answers. */
export class ViewShelf {
  private readonly blocks = new Map<number, string>();
  private placed = new Set<number>();
  private next = 1;

  add(block: string): string {
    const n = this.next++;
    this.blocks.set(n, block);
    return `[[view:${n}]]`;
  }

  /** The views the text places, and the tokens it means as text (in code, or quoted and for no view) left out. */
  private tokens(text: string): { m: RegExpMatchArray; block?: string }[] {
    const out: { m: RegExpMatchArray; block?: string }[] = [];
    for (const m of text.includes('[[view:') ? text.matchAll(PIECES) : []) {
      const { n, tick } = m.groups!;
      if (n === undefined) continue;
      const block = this.blocks.get(Number(n));
      if (block || !tick) out.push({ m, block });
    }
    return out;
  }

  /**
   * Text as it's being written: tokens become their views. One with no view (Claude wrote it by
   * hand) goes, and its line with it when it stood alone.
   */
  expand(text: string): string {
    const found = this.tokens(text);
    if (!found.length && !this.blocks.size) return text;
    let out = '';
    let at = 0;
    for (const { m, block } of found) {
      const { before = '', after = '' } = m.groups!;
      const end = m.index! + m[0].length;
      const next = text[end];
      // Gone mid-sentence, one space stays between the words around it.
      const gap = before || after ? (before.length >= after.length ? before : after) : m.index && next !== undefined && !/[\s.,;:!?)]/.test(next) ? ' ' : '';
      out += text.slice(at, m.index) + (block ? `\n\n${block}\n\n` : gap);
      at = end;
    }
    return (out + text.slice(at)).replace(/^\n+|\n+$/g, '').replace(/\n{3,}(?=```beluga-)|(?<=```)\n{3,}/g, '\n\n');
  }

  /** A turn's answer: its tokens filled in, and views it didn't place added at the end. */
  finish(text: string): string {
    for (const { m, block } of this.tokens(text)) if (block) this.placed.add(Number(m.groups!.n));
    const rest = [...this.blocks.keys()].filter((n) => !this.placed.has(n));
    rest.forEach((n) => this.placed.add(n));
    const body = this.expand(text);
    return rest.length ? [body, ...rest.map((n) => this.blocks.get(n)!)].filter(Boolean).join('\n\n') : body;
  }
}

const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, os.homedir());

/** Paths made whole (the window and other conversations don't know this one's folder). */
export function anchorSource(source: Source, cwd: string): Source {
  const abs = (p: string): string => path.resolve(cwd, expandHome(p));
  if (source.kind === 'command') return { ...source, cwd: source.cwd ? abs(source.cwd) : cwd };
  // Postgres and BigQuery find their connection in the variables of the project they were shown in.
  if (source.kind === 'postgres' || source.kind === 'bigquery') return { ...source, cwd: source.cwd ? abs(source.cwd) : cwd };
  if ('path' in source) return { ...source, path: abs(source.path) } as Source;
  return source;
}

function preview(page: ViewPage): string {
  const rows = page.rows.slice(0, 5).map((r: Row) => JSON.stringify(r).slice(0, 300));
  return [
    `Columns: ${page.columns.join(', ') || '(none)'}`,
    `Rows: ${page.total ?? page.rows.length}${page.hasMore ? '+' : ''}${page.truncated ? ' (cut short)' : ''}`,
    ...(rows.length ? ['First rows:', ...rows] : []),
  ].join('\n');
}

/** The most Markdown one block from `show_block` keeps. */
const MAX_BLOCK = 60_000;

/**
 * The terminal's `show_block` (BLG-535): anything else the chat draws, kept like a view, so it opens
 * beside the terminal exactly as the chat draws it. Only in the agent's terminal.
 */
const blockTool = (shelf: ViewShelf) =>
  tool(
    'show_block',
    'In Beluga\'s terminal view only: show anything the chat draws that a terminal can\'t (task cards in a ```beluga-tasks block, code from this repository in a ```beluga-code block, a pull request\'s comments, a ```mermaid diagram, a picture as ![name](/absolute/path.png), a file tree or any other Markdown). Pass the Markdown exactly as you would write it in the chat. Returns a token: write it on a line of its own where the block goes; the user opens it beside the terminal, drawn as in the chat.',
    { markdown: z.string().min(1).max(MAX_BLOCK).describe('The Markdown, as the chat would draw it') },
    async (a) => {
      const text = a.markdown.trim();
      if (!text) return { content: [{ type: 'text' as const, text: 'Nothing to show.' }], isError: true };
      const token = shelf.add(text);
      return { content: [{ type: 'text' as const, text: `Shown as ${token}. Put ${token} on its own line in your answer where it goes.` }] };
    },
  );

export function createViewTools(shelf: ViewShelf, cwd: string) {
  return toolSuite({
    name: 'beluga_view',
    version: '0.1.0',
    tools: [
      ...(shelf instanceof TerminalShelf ? [blockTool(shelf)] : []),
      tool(
        'show',
        'Show data to the user as a live element in your answer: a table, chart (line, area, bar, pie, donut, scatter), stat tiles, code, a color palette (or picker), a gantt (bars over time), a heatmap (x by y by value), a calendar (values by day), or a graph. Pass the element as JSON (the beluga-view format; for a graph, type "graph" with the beluga-graph fields). Give rows in "data", or a "source" the app fetches more from on its own (file, folder, sqlite, postgres, http, command, or script: code you write for it): it runs once now and the first rows come back to you. Returns the element\'s token: put that exact token on its own line in your answer where the element goes (else it is added at the end). Only tokens this tool returned mean anything: never write one by hand (one with no element is dropped), and show a picture you made as a Markdown image with its absolute path, not with this tool.',
        { view: z.record(z.string(), z.unknown()).describe('The element: {"type": "table"|"chart"|"stats"|"code"|"colors"|"graph", "title", ...}') },
        async (a) => {
          try {
            return { content: [{ type: 'text' as const, text: await showView(shelf, cwd, a.view) }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
          }
        },
      ),
    ],
  });
}

/** Every source in a view (its own, its actions', its controls' and their options') with whole paths, scripts written down. */
function anchorAll(raw: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const fix = (s: unknown): unknown => {
    // A script Claude wrote for the view: kept as a file, run as a command (core/views/scripts.ts).
    const script = planScript(s, cwd);
    if (script) {
      if (mentionsSecret(script.code)) throw new Error('Beluga never runs scripts that touch credential files');
      writeScript(script);
      return script.source;
    }
    const parsed = SourceSchema.safeParse(s);
    return parsed.success ? anchorSource(parsed.data as Source, cwd) : s;
  };
  const each = (list: unknown, f: (x: Record<string, unknown>) => Record<string, unknown>): unknown => (Array.isArray(list) ? list.map((x) => (x && typeof x === 'object' ? f(x as Record<string, unknown>) : x)) : list);
  const withSource = (x: Record<string, unknown>): Record<string, unknown> => (x.source === undefined ? x : { ...x, source: fix(x.source) });
  const out = withSource(raw);
  if (out.actions) out.actions = each(out.actions, withSource);
  if (out.controls) out.controls = each(out.controls, (c) => ({ ...withSource(c), ...(c.options ? { options: each(c.options, withSource) } : {}) }));
  return out;
}

const DUMP_OVER = 200;

/** Lots of rows in `data`: write them to a file and make that the view's source. → how many, or 0. */
function dumpData(out: Record<string, unknown>): number {
  if (out.source !== undefined || out.data === undefined || String(out.type ?? 'table') === 'code') return 0;
  const { rows } = toRows(out.data, Array.isArray(out.columns) ? (out.columns as unknown[]).map((c) => ({ key: typeof c === 'string' ? c : String((c as { key?: unknown }).key ?? '') })) : undefined);
  if (rows.length <= DUMP_OVER) return 0;
  const body = JSON.stringify(rows.slice(0, MAX_SOURCE_ROWS));
  const file = path.join(viewDataDir(), `${createHash('sha256').update(body).digest('hex').slice(0, 16)}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  out.source = { kind: 'file', path: file, format: 'json' };
  delete out.data;
  return Math.min(rows.length, MAX_SOURCE_ROWS);
}

export async function showView(shelf: ViewShelf, cwd: string, raw: Record<string, unknown>): Promise<string> {
  if (String(raw.type ?? '').toLowerCase() === 'graph' || Array.isArray(raw.nodes)) {
    const { type: _t, ...graph } = raw;
    const parsed = parseGraph(JSON.stringify(graph));
    if (!parsed.ok) throw new Error(`Not a graph: ${parsed.error}`);
    const token = shelf.add(viewBlock(graph, GRAPH_FENCE));
    return [`Shown as ${token}.`, ...parsed.warnings.map((w) => `Note: ${w}`)].join('\n');
  }
  const notes: string[] = [];
  const out: Record<string, unknown> = anchorAll({ ...raw }, cwd);
  // All the data at once: kept in a file the view reads, so the answer carries only its first rows.
  const dumped = dumpData(out);
  if (dumped) notes.push(`All ${dumped} rows are kept for the view; the user can sort, filter and page them without you.`);
  const first = readView(out);
  if (!first.ok) throw new Error(`Not a view: ${first.error}`);
  const view = first.view;
  notes.push(...first.warnings);
  // The first rows as the view starts: its controls' defaults (a top 5, a filter) already applied.
  const patch = resolveControls(view, initialState(view));
  const shown = patch.source ?? view.source;
  if (shown) {
    const source = shown;
    const limit = view.type === 'code' ? 1 : Math.max(view.pageSize, SNAPSHOT_ROWS[view.type]);
    const query = { offset: 0, limit, ...(patch.sort ? { sort: patch.sort } : {}), ...(patch.search ? { search: patch.search } : {}), ...(patch.where ? { where: patch.where } : {}), ...(patch.top ? { top: patch.top } : {}), ...(patch.params ? { params: patch.params } : {}) };
    // This tool call was allowed (a command asks like Bash does), so the source may run from now on.
    const page = await fetchSource(source, query, { confirm: true, fresh: true, text: view.type === 'code', cwd });
    if (!('rows' in page)) throw new Error('The source needs approval first');
    if (view.type === 'code') {
      if (raw.code === undefined) out.code = page.text ?? '';
    } else {
      out.data = page.rows.slice(0, SNAPSHOT_ROWS[view.type]);
      delete out.total;
      if (page.total !== undefined) out.total = page.total;
      notes.push(preview(page));
    }
    out.at = page.at;
  }
  const checked = readView(out);
  if (!checked.ok) throw new Error(`Not a view: ${checked.error}`);
  if (view.controls.length) notes.push(`Controls: ${view.controls.map((c) => c.label ?? c.id).join(', ')} (they work without you).`);
  const token = shelf.add(viewBlock(out, VIEW_FENCE));
  return [`Shown as ${token}. Put ${token} on its own line in your answer where it goes.`, ...notes].join('\n');
}

/**
 * The views of the agent's own terminal (BLG-535): each kept by the daemon (`sink`), and its token
 * `[[visual:N]]` is what Claude writes; the Mac draws a link over it (shared/term-visuals.ts).
 */
export class TerminalShelf extends ViewShelf {
  constructor(private readonly sink: TerminalSink) {
    super();
  }

  override add(block: string): string {
    return visualToken(this.sink.add(block));
  }
}
