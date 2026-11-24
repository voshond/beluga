import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { needPosixSh } from '../../terminal/pty.js';
import { killTree, ownGroup } from '../process-tree.js';
import {
  type Cell,
  MAX_SOURCE_ROWS,
  type Row,
  type Source,
  type ViewFetchResult,
  type ViewPage,
  type ViewQuery,
  describeSource,
  pageOf,
  queryRows,
  parseText,
  pick,
  sourceKey,
  toRows,
  totalOf,
} from '../../shared/view-spec.js';
import { mentionsSecret } from '../../agent/policy.js';
import { isSecretPath } from '../shares.js';
import { loadEnvFile } from '../env-vars.js';
import { type FoundDatabase, databaseUrl, databaseUrlOf } from './database-url.js';
import { PSQL_MISSING, type Psql, connectPostgres } from './postgres-connect.js';
import { TOTAL_COLUMN, bigqueryPageSql, bigqueryRun, bqLiteral, queryBigquery } from './bigquery.js';
import { belugaHome } from '../home.js';
import { keep, recall } from './kept.js';

/**
 * Running a view's source (shared/view-spec.ts) on this computer: a file, a folder, a SQLite,
 * Postgres or BigQuery query, a web address or a command, turned into rows. Databases and commands that say
 * where a page goes ({{limit}}, {{offset}}, {{search}}…) sort, search and page at the source;
 * everything else is fetched whole (up to MAX_SOURCE_ROWS), kept a little while, and paged here.
 * Credential files are never read, and a command runs only once its owner said yes (Claude's
 * `show` tool asks like Bash does; the window asks the first time).
 */

const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const DEFAULT_TIMEOUT = 30;
/** How long a source fetched whole is kept for paging and sorting without running it again. */
const KEEP_MS = 60_000;

export interface FetchOptions {
  /** Where relative paths and commands start (the conversation's folder). */
  readonly cwd?: string;
  /** The owner said yes to running it (a command that hasn't run before). */
  readonly confirm?: boolean;
  /** Fetch again even if it was fetched a moment ago (Refresh). */
  readonly fresh?: boolean;
  /** A code view: the text itself, not rows. */
  readonly text?: boolean;
  /**
   * What was fetched before, if anything, however old (kept.ts): 'prefer' runs the source when
   * nothing was kept; 'only' never runs it ({ notKept } instead). A source with `refresh` keeps
   * its rows only that long. `fresh` wins.
   */
  readonly cache?: 'prefer' | 'only';
}

const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, os.homedir());
const resolvePath = (p: string, cwd: string | undefined): string => path.resolve(cwd ?? os.homedir(), expandHome(p));

// ---------------------------------------------------------------- which commands may run

/** Commands (and their folders) their owner said yes to: kept in ~/.beluga/view-approvals.json. */
class Approvals {
  private keys: Set<string> | undefined;
  private file = (): string => path.join(belugaHome(), 'view-approvals.json');
  private load(): Set<string> {
    if (this.keys) return this.keys;
    try {
      const raw = JSON.parse(readFileSync(this.file(), 'utf8')) as unknown;
      this.keys = new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string').slice(-2000) : []);
    } catch {
      this.keys = new Set();
    }
    return this.keys;
  }
  has(key: string): boolean {
    return this.load().has(key);
  }
  add(key: string): void {
    const keys = this.load();
    if (keys.has(key)) return;
    keys.add(key);
    try {
      mkdirSync(belugaHome(), { recursive: true });
      writeFileSync(this.file(), JSON.stringify([...keys].slice(-2000)), { mode: 0o600 });
    } catch {
      // Kept for this run only.
    }
  }
}
export const approvals = new Approvals();
const approvalKey = (command: string, cwd: string | undefined): string => `${cwd ?? '~'}\u0000${command}`;

/** Whether a source runs something that needs its owner's yes, and what to show them. */
export function needsYes(source: Source, cwd?: string): string | undefined {
  const what = askFor(source);
  return what === undefined || approvals.has(approvalKey(what, 'cwd' in source && source.cwd ? source.cwd : cwd)) ? undefined : what;
}
/** The owner said yes to this source (Claude's tool was allowed, or the window's Run). */
export function approve(source: Source, cwd?: string): void {
  const what = askFor(source);
  if (what !== undefined) approvals.add(approvalKey(what, 'cwd' in source && source.cwd ? source.cwd : cwd));
}
/** Commands ask; so does an address that would carry one of your variables (a token) somewhere. */
function askFor(source: Source): string | undefined {
  if (source.kind === 'command') return source.command;
  if (source.kind === 'http' && Object.values(source.headers ?? {}).some((v) => /\$\{?[A-Za-z_]/.test(v))) return `${source.method} ${source.url} (with ${Object.keys(source.headers ?? {}).join(', ')})`;
  return undefined;
}

/** Why a source may never run here, if it may not. */
export function refusal(source: Source, cwd?: string): string | undefined {
  const paths = 'path' in source ? [resolvePath(source.path, cwd)] : [];
  if (paths.some(isSecretPath)) return 'Beluga never reads credential files';
  if (source.kind === 'command' && mentionsSecret(source.command)) return 'Beluga never runs commands that touch credential files';
  if (source.kind === 'http' && !/^https?:\/\//i.test(source.url)) return 'Only http and https addresses';
  return undefined;
}

// ---------------------------------------------------------------- fetching

interface Whole {
  readonly rows: Row[];
  readonly columns: string[];
  readonly text?: string;
  readonly total?: number;
  readonly truncated?: boolean;
  readonly at: number;
}
const kept = new Map<string, Whole>();
const inFlight = new Map<string, Promise<Whole>>();

/** One page of a source's rows (or its text), sorted and searched as asked. */
export async function fetchSource(source: Source, query: ViewQuery, opts: FetchOptions = {}): Promise<ViewFetchResult> {
  const why = refusal(source, opts.cwd);
  if (why) throw new Error(why);
  if (opts.confirm) approve(source, opts.cwd);
  const bound = bind(source, query.params);
  if (refusal(bound, opts.cwd)) throw new Error(refusal(bound, opts.cwd));
  const keys = keysOfFetch(source, bound, query, opts);
  // What it brought before (it ran with its owner's yes then): shown again without running it.
  if (opts.cache && !opts.fresh) {
    const was = recallFetch(bound, query, keys, opts);
    if (was) return was;
    if (opts.cache === 'only') return { notKept: true };
  }
  // Asked once per command as Claude wrote it: the values its controls fill in don't ask again.
  const ask = needsYes(source, opts.cwd);
  if (ask) return { needsApproval: true, what: ask };
  source = bound;
  if (keys.page) {
    const pushed = (await pushedDown(source, query, opts))!;
    keep(keys.group, keys.page, pushed.at, pushed);
    return pushed;
  }
  const key = keys.whole;
  const maxAge = source.refresh ? Math.max(1000, source.refresh * 1000 - 250) : KEEP_MS;
  let whole = opts.fresh ? undefined : kept.get(key);
  if (!whole || Date.now() - whole.at > maxAge) {
    let running = inFlight.get(key);
    if (!running) {
      running = fetchWhole(source, opts)
        .then((w) => (keep(keys.group, key, w.at, w), w))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, running);
    }
    whole = await running;
    kept.set(key, whole);
    // Keep the newest few.
    if (kept.size > 40) kept.delete(kept.keys().next().value!);
  }
  return pageOfWhole(whole, query, opts);
}

function pageOfWhole(whole: Whole, query: ViewQuery, opts: FetchOptions): ViewPage {
  if (opts.text) return { rows: [], columns: [], at: whole.at, hasMore: false, text: whole.text ?? '' };
  const page = pageOf(whole.rows, query);
  return { ...page, columns: whole.columns, at: whole.at, ...(whole.truncated ? { truncated: true } : {}) };
}

/**
 * Where a fetch is kept (kept.ts): a source that pages itself, per page asked for; anything else
 * whole, and paged from that.
 */
function keysOfFetch(named: Source, source: Source, query: ViewQuery, opts: FetchOptions): Keys {
  // Grouped by the source as the view names it (before its controls fill it in), so it can be forgotten with its view.
  const group = sourceKey(named);
  // Where it ran only matters to a source that doesn't say (the show tool makes paths whole, so its first fetch is the window's too).
  const place = ('path' in source && !path.isAbsolute(source.path)) || ((source.kind === 'command' || source.kind === 'postgres' || source.kind === 'bigquery') && !source.cwd) ? (opts.cwd ?? '') : '';
  const whole = `${sourceKey(source)}\u0000${place}\u0000${opts.text ? 't' : 'r'}`;
  if (opts.text || !pagesItself(source)) return { group, whole };
  const { params: _p, ...q } = query;
  return { group, whole, page: `${whole}\u0000${JSON.stringify(q)}` };
}
type Keys = { readonly group: string; readonly whole: string; readonly page?: string };

function recallFetch(source: Source, query: ViewQuery, keys: Keys, opts: FetchOptions): ViewPage | undefined {
  const was = keys.page ? recall<ViewPage>(keys.group, keys.page) : recall<Whole>(keys.group, keys.whole);
  // A source that refreshes itself keeps its rows only that long.
  if (!was || (source.refresh && Date.now() - was.at > source.refresh * 1000)) return undefined;
  return keys.page ? { ...(was.value as ViewPage), at: was.at } : pageOfWhole({ ...(was.value as Whole), at: was.at }, query, opts);
}


async function fetchWhole(source: Source, opts: FetchOptions): Promise<Whole> {
  const at = Date.now();
  const timeout = ('timeout' in source && source.timeout ? source.timeout : DEFAULT_TIMEOUT) * 1000;
  switch (source.kind) {
    case 'file': {
      const file = resolvePath(source.path, opts.cwd);
      const info = await stat(file);
      if (info.isDirectory()) return folderRows({ kind: 'folder', path: file }, opts, at);
      if (info.size > MAX_FILE) throw new Error(`${path.basename(file)} is too big to show (${Math.round(info.size / 1e6)} MB)`);
      const text = await readFile(file, 'utf8');
      if (opts.text) return { rows: [], columns: [], text, at };
      const format = source.format !== 'auto' ? source.format : formatOf(file);
      return { ...rowsOfText(text, format, source.rows), at };
    }
    case 'folder':
      return folderRows(source, opts, at);
    case 'sqlite': {
      const rows = await sqlite(resolvePath(source.path, opts.cwd), `SELECT * FROM (${bare(source.query)}) LIMIT ${MAX_SOURCE_ROWS + 1}`, timeout);
      return { ...capped(rows), at };
    }
    case 'postgres': {
      const rows = await postgres(source, `SELECT * FROM (${bare(source.query)}) s LIMIT ${MAX_SOURCE_ROWS + 1}`, timeout, opts.cwd);
      return { ...capped(rows), at };
    }
    case 'bigquery': {
      const rows = await bigquery(source, `SELECT * FROM (${bare(source.query)}) s LIMIT ${MAX_SOURCE_ROWS + 1}`, timeout, MAX_SOURCE_ROWS + 1, opts.cwd);
      return { ...capped(rows), at };
    }
    case 'http': {
      const { text, json } = await httpGet(source, fill(source.url, undefined, encodeURIComponent), timeout);
      if (opts.text) return { rows: [], columns: [], text, at };
      if (json !== undefined) {
        const t = totalOf(json);
        const { rows, columns } = toRows(pick(json, source.rows));
        return { ...capped(rows, columns), ...(t !== undefined ? { total: t } : {}), at };
      }
      return { ...rowsOfText(text, source.format, undefined), at };
    }
    case 'command': {
      const out = await shell(fill(source.command, undefined, shellQuote), source.cwd ? resolvePath(source.cwd, opts.cwd) : (opts.cwd ?? os.homedir()), timeout);
      if (opts.text) return { rows: [], columns: [], text: out, at };
      return { ...rowsOfText(out, source.format, source.rows), at };
    }
  }
}

function capped(rows: Row[], columns?: string[]): { rows: Row[]; columns: string[]; truncated?: boolean } {
  const cols = columns ?? keysOf(rows);
  return rows.length > MAX_SOURCE_ROWS ? { rows: rows.slice(0, MAX_SOURCE_ROWS), columns: cols, truncated: true } : { rows, columns: cols };
}
const keysOf = (rows: readonly Row[]): string[] => [...new Set(rows.slice(0, 200).flatMap((r) => Object.keys(r)))];

function rowsOfText(text: string, format: Parameters<typeof parseText>[1], at: string | undefined): { rows: Row[]; columns: string[]; text: string; truncated?: boolean } {
  if (at && /^\s*[[{]/.test(text)) {
    const { rows, columns } = toRows(pick(JSON.parse(text), at));
    return { ...capped(rows, columns), text };
  }
  const { rows, columns } = parseText(text, format);
  return { ...capped(rows, columns), text };
}

const formatOf = (file: string): Parameters<typeof parseText>[1] => {
  const ext = path.extname(file).toLowerCase();
  return ext === '.csv' ? 'csv' : ext === '.tsv' || ext === '.tab' ? 'tsv' : ext === '.json' ? 'json' : ext === '.jsonl' || ext === '.ndjson' ? 'jsonl' : 'auto';
};

/** A query without its last ";" (it goes inside another). */
const bare = (q: string): string => q.trim().replace(/;+\s*$/, '');

// ---------------------------------------------------------------- folders

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += `(${glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
        i = end;
      } else re += '\\{';
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

async function folderRows(source: Extract<Source, { kind: 'folder' }>, opts: FetchOptions, at: number): Promise<Whole> {
  const root = resolvePath(source.path, opts.cwd);
  const match = source.glob ? globToRegExp(source.glob) : undefined;
  const deep = source.recursive ?? Boolean(source.glob?.includes('/') || source.glob?.includes('**'));
  const rows: Row[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (rows.length >= MAX_ENTRIES) return void (truncated = true);
      if (!source.hidden && e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (isSecretPath(full)) continue;
      const rel = path.relative(root, full);
      const isDir = e.isDirectory();
      if (isDir && deep && depth < 12 && e.name !== 'node_modules' && e.name !== '.git') await walk(full, depth + 1);
      if (match && !(match.test(rel) || match.test(e.name))) continue;
      if (match && isDir) continue;
      let size: Cell = null;
      let modified: Cell = null;
      try {
        const st = await stat(full);
        size = isDir ? null : st.size;
        modified = Math.round(st.mtimeMs);
      } catch {
        // Gone meanwhile.
      }
      rows.push({ name: deep ? rel : e.name, kind: isDir ? 'folder' : e.isSymbolicLink() ? 'link' : 'file', size, modified, path: full });
    }
  };
  await walk(root, 0);
  rows.sort((a, b) => (a.kind === b.kind ? String(a.name).localeCompare(String(b.name), undefined, { numeric: true }) : a.kind === 'folder' ? -1 : 1));
  return { rows, columns: ['name', 'kind', 'size', 'modified', 'path'], at, ...(truncated ? { truncated } : {}) };
}

// ---------------------------------------------------------------- databases: paged at the source

const quoteIdent = (k: string): string => `"${k.replace(/"/g, '""')}"`;
const quoteText = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** A database, or a command or address that says where a page goes ({{limit}}, {{offset}}…). */
const pagesItself = (source: Source): boolean => source.kind === 'sqlite' || source.kind === 'postgres' || source.kind === 'bigquery' || (source.kind === 'command' && TEMPLATE.test(source.command)) || (source.kind === 'http' && TEMPLATE.test(source.url + (source.body ?? '')));

/** A database (or a command or address that says where a page goes) pages, sorts and searches itself. */
async function pushedDown(source: Source, q: ViewQuery, opts: FetchOptions): Promise<ViewPage | undefined> {
  const at = Date.now();
  const timeout = ('timeout' in source && source.timeout ? source.timeout : DEFAULT_TIMEOUT) * 1000;
  if (source.kind === 'sqlite') {
    const db = resolvePath(source.path, opts.cwd);
    const inner = bare(source.query);
    const columns = keysOf(await sqlite(db, `SELECT * FROM (${inner}) LIMIT 1`, timeout));
    const where = whereClause(q, (n) => (columns.length ? `(${columns.map((k) => like(`CAST(${quoteIdent(k)} AS TEXT)`, n)).join(' OR ')})` : undefined), (k, v) => like(`CAST(${quoteIdent(k)} AS TEXT)`, v));
    const order = q.sort && columns.includes(q.sort.key) ? ` ORDER BY ${quoteIdent(q.sort.key)} ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'}` : '';
    const sel = `SELECT * FROM (${inner})${andWhere(where, q, columns, 'CAST(%k AS TEXT)')}${order}`;
    const kept = q.top ? `SELECT * FROM (${sel} LIMIT ${q.top})${order}` : sel;
    const [rows, count] = await Promise.all([sqlite(db, `${kept} LIMIT ${q.limit} OFFSET ${q.offset}`, timeout), sqlite(db, `SELECT count(*) AS n FROM (${kept})`, timeout)]);
    const total = Number(count[0]?.n ?? rows.length);
    return { rows, columns: columns.length ? columns : keysOf(rows), total, hasMore: q.offset + rows.length < total, at, pushedDown: true };
  }
  if (source.kind === 'postgres') {
    const inner = bare(source.query);
    // A whole row as text searches every column without knowing them.
    const where = whereClause(q, (n) => like('s::text', n, 'ILIKE'), (k, v) => like(`${quoteIdent(k)}::text`, v, 'ILIKE'));
    const order = q.sort ? ` ORDER BY ${quoteIdent(q.sort.key)} ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST` : '';
    const sel = `SELECT * FROM (${inner}) s${andWhere(where, q, undefined, '%k::text')}${order}`;
    const kept = q.top ? `SELECT * FROM (${sel} LIMIT ${q.top}) s${order}` : sel;
    const [rows, count] = await Promise.all([postgres(source, `${kept} LIMIT ${q.limit} OFFSET ${q.offset}`, timeout, opts.cwd), postgres(source, `SELECT count(*) AS n FROM (${kept}) c`, timeout, opts.cwd)]);
    const total = Number(count[0]?.n ?? rows.length);
    return { rows, columns: keysOf(rows), total, hasMore: q.offset + rows.length < total, at, pushedDown: true };
  }
  if (source.kind === 'bigquery') {
    const found = await bigquery(source, bigqueryPageSql(bare(source.query), q), timeout, q.limit, opts.cwd);
    const total = Number(found[0]?.[TOTAL_COLUMN] ?? 0);
    const rows = found.map(({ [TOTAL_COLUMN]: _n, ...row }) => row);
    return { rows, columns: keysOf(rows), total, hasMore: q.offset + rows.length < total, at, pushedDown: true };
  }
  if (source.kind === 'command' && TEMPLATE.test(source.command)) {
    const out = await shell(fill(source.command, q, shellQuote), source.cwd ? resolvePath(source.cwd, opts.cwd) : (opts.cwd ?? os.homedir()), timeout);
    return templatedPage(out, source.format, source.rows, q, at);
  }
  if (source.kind === 'http' && TEMPLATE.test(source.url + (source.body ?? ''))) {
    const { text, json } = await httpGet(source, fill(source.url, q, encodeURIComponent), timeout, source.body ? fill(source.body, q, jsonQuote) : undefined);
    if (json === undefined) return templatedPage(text, source.format, undefined, q, at);
    const { rows, columns } = toRows(pick(json, source.rows));
    const total = totalOf(json);
    return { rows: rows.slice(0, q.limit), columns, ...(total !== undefined ? { total } : {}), hasMore: total !== undefined ? q.offset + rows.length < total : rows.length >= q.limit, at, pushedDown: true };
  }
  return undefined;
}

function templatedPage(out: string, format: Parameters<typeof parseText>[1], at: string | undefined, q: ViewQuery, now: number): ViewPage {
  const parsed = at && /^\s*[[{]/.test(out) ? toRows(pick(JSON.parse(out), at)) : parseText(out, format);
  // What the page's own slots didn't do (a control's condition, a top N) is done to the page here.
  const rows = q.where?.length || q.top ? queryRows(parsed.rows, { ...(q.where ? { where: q.where } : {}), ...(q.top ? { top: q.top } : {}) }) : parsed.rows;
  const columns = parsed.columns;
  const total = /^\s*\{/.test(out) ? totalOf(safeJson(out)) : undefined;
  return { rows: rows.slice(0, q.limit), columns, ...(total !== undefined ? { total } : {}), hasMore: total !== undefined ? q.offset + rows.length < total : rows.length >= q.limit, at: now, pushedDown: true };
}
const safeJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, '\\$&');
const like = (expr: string, needle: string, op = 'LIKE'): string => `${expr} ${op} ${quoteText(`%${likeEscape(needle)}%`)} ESCAPE '\\'`;
/** WHERE for a search (`search`: the condition for one needle) and column filters. */
function whereClause(q: ViewQuery, search: (needle: string) => string | undefined, filter: (k: string, v: string) => string): string {
  const parts: string[] = [];
  const needle = q.search?.trim();
  const found = needle ? search(needle) : undefined;
  if (found) parts.push(found);
  for (const [k, v] of Object.entries(q.filters ?? {})) if (v.trim()) parts.push(filter(k, v.trim()));
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

const SQL_OP: Readonly<Record<string, string>> = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const sqlValue = (v: unknown): string => (typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? '1' : '0') : v === null ? 'NULL' : quoteText(String(v)));

/** The controls' conditions added to a WHERE (`text`: how a column reads as text, %k its name). */
function andWhere(where: string, q: ViewQuery, columns: readonly string[] | undefined, text: string): string {
  const conds = (q.where ?? []).filter((c) => !columns || columns.includes(c.key));
  if (!conds.length) return where;
  const parts = conds.map((c) => {
    const k = quoteIdent(c.key);
    if (c.op === 'contains') return like(text.replace('%k', k), String(c.value ?? ''), text.includes('::') ? 'ILIKE' : 'LIKE');
    if (c.op === 'in') return Array.isArray(c.value) && c.value.length ? `${k} IN (${c.value.map(sqlValue).join(', ')})` : '1 = 0';
    return `${k} ${SQL_OP[c.op]} ${sqlValue(c.value)}`;
  });
  return where ? `${where} AND ${parts.join(' AND ')}` : ` WHERE ${parts.join(' AND ')}`;
}

async function sqlite(db: string, sql: string, timeout: number): Promise<Row[]> {
  // Read-only: nothing a view runs can change the database.
  const out = await run('sqlite3', ['-readonly', '-json', '-bail', db, sql], { timeout });
  return out.trim() ? toRows(JSON.parse(out)).rows : [];
}

async function postgres(source: Extract<Source, { kind: 'postgres' }>, sql: string, timeout: number, cwd: string | undefined): Promise<Row[]> {
  // Without "env" or "url": the project's own database (DATABASE_URL…, or Supabase's variables).
  // Read each time: a change in Settings › Environment or env.json applies to the next run.
  const place = viewEnv.database(source.cwd ?? cwd);
  const env = { ...process.env, ...place.vars };
  const found = source.url && !source.env ? databaseUrlOf(source.url, 'its address', env) : databaseUrl(env, source.env);
  if ('problem' in found) throw new Error(`${found.problem}. Looked in ${place.where}.`);
  return queryPostgres(found, sql, timeout);
}

async function bigquery(source: Extract<Source, { kind: 'bigquery' }>, sql: string, timeout: number, max: number, cwd: string | undefined): Promise<Row[]> {
  // The key is found as Postgres's connection string is: your variables, the project's, its .env.
  const place = viewEnv.database(source.cwd ?? cwd);
  const run = bigqueryRun(source, { ...process.env, ...place.vars });
  if ('problem' in run) throw new Error(`${run.problem}. Looked in ${place.where}.`);
  return queryBigquery(run, sql, timeout, max);
}

/**
 * Settings › Environment's Test connection: the database a view there would use, asked SELECT 1.
 * → which variables it came from, or what went wrong (never a value).
 */
export async function testDatabase(place: { readonly vars: Record<string, string>; readonly where: string }): Promise<{ ok: true; from: string } | { ok: false; message: string }> {
  const found = databaseUrl({ ...process.env, ...place.vars });
  if ('problem' in found) return { ok: false, message: `${found.problem}. Looked in ${place.where}.` };
  try {
    await queryPostgres(found, 'SELECT 1 AS ok', 15_000);
    return { ok: true, from: found.from };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** psql, read-only: every statement in a read-only transaction; a dead address gives up soon. */
const psql: Psql = async (url, sql, timeout) => {
  try {
    return await run('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-c', `SELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t`], {
      timeout,
      env: { PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=' + timeout, PGCONNECT_TIMEOUT: '8' },
    });
  } catch (err) {
    throw err instanceof Error && err.message === 'psql isn’t installed' ? new Error(PSQL_MISSING) : err;
  }
};

/**
 * Run a query against the first address that answers (postgres-connect.ts: Supabase's direct
 * address, then its session pooler, found if need be; the project's other passwords). Errors never
 * carry the connection string or its password.
 */
export async function queryPostgres(found: FoundDatabase, sql: string, timeout: number): Promise<Row[]> {
  const out = await connectPostgres(found, sql, timeout, psql);
  return out.trim() ? toRows(JSON.parse(out)).rows : [];
}

/** Your variables for a view shown there: for a database (and where they came from), and for a command. */
export interface ViewEnv {
  readonly database: (cwd?: string) => { readonly vars: Record<string, string>; readonly where: string };
  readonly commands: (cwd?: string) => Record<string, string>;
}
/** Set by the session (EnvVars: yours, the project's, its .env); before that, just yours. */
let viewEnv: ViewEnv = { database: () => ({ vars: loadEnvFile().global, where: 'your variables (Settings › Environment)' }), commands: () => loadEnvFile().global };
/** Where views find your variables, read fresh each time they run (see EnvVars.viewEnv). */
export function useViewEnv(env: ViewEnv): void {
  viewEnv = env;
}

/** Your variables for a command run in `cwd` (as a view's command gets them): sentinels' scripts use them too. */
export const commandEnv = (cwd?: string): Record<string, string> => viewEnv.commands(cwd);

/** A variable from your Beluga environment (Settings), else Beluga's own. */
function envValue(name: string): string | undefined {
  return loadEnvFile().global[name] ?? process.env[name];
}

// ---------------------------------------------------------------- commands and addresses

const TEMPLATE = /\{\{\s*(limit|offset|page|search|sort|order)\s*\}\}/;
const RESERVED = new Set(['limit', 'offset', 'page', 'search', 'sort', 'order']);
const SLOT = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;
const sqlLiteral = (v: string): string => (/^-?\d+(\.\d+)?$/.test(v) ? v : quoteText(v));

/** A source with its controls' values in its {{slots}}, each quoted for where it goes. */
export function bind(source: Source, params: Readonly<Record<string, string | number | boolean>> | undefined): Source {
  const put = (t: string, quote: (v: string) => string): string =>
    t.replace(SLOT, (m, name: string) => {
      if (RESERVED.has(name)) return m;
      const v = params?.[name];
      return v === undefined || v === '' ? (quote === shellQuote ? "''" : quote === sqlLiteral || quote === bqLiteral ? 'NULL' : '') : quote(String(v));
    });
  if (!/\{\{\s*[A-Za-z_]/.test(JSON.stringify(source))) return source;
  switch (source.kind) {
    case 'command':
      return { ...source, command: put(source.command, shellQuote) };
    case 'http':
      return { ...source, url: put(source.url, encodeURIComponent), ...(source.body ? { body: put(source.body, jsonQuote) } : {}) };
    case 'sqlite':
    case 'postgres':
      return { ...source, query: put(source.query, sqlLiteral) };
    case 'bigquery':
      return { ...source, query: put(source.query, bqLiteral) };
    case 'file':
    case 'folder':
      return { ...source, path: put(source.path, (v) => v.replace(/\.\.\//g, '')) } as Source;
  }
}
const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const jsonQuote = (s: string): string => JSON.stringify(s).slice(1, -1);

/** {{limit}}, {{offset}}, {{page}} (from 1), {{search}}, {{sort}} and {{order}}, quoted for where they go. */
function fill(template: string, q: ViewQuery | undefined, quote: (s: string) => string): string {
  const limit = q?.limit ?? 100;
  const values: Record<string, string> = {
    limit: String(limit),
    offset: String(q?.offset ?? 0),
    page: String(Math.floor((q?.offset ?? 0) / limit) + 1),
    search: q?.search ?? '',
    sort: q?.sort?.key ?? '',
    order: q?.sort?.dir ?? '',
  };
  return template.replace(/\{\{\s*(limit|offset|page|search|sort|order)\s*\}\}/g, (_m, k: string) => {
    const v = values[k] ?? '';
    // Numbers go in as they are; words are quoted.
    return /^\d+$/.test(v) ? v : quote(v);
  });
}

async function shell(command: string, cwd: string, timeout: number): Promise<string> {
  // The same variables your Claude's own commands get there (yours, the project's, its .env when on).
  return run(needPosixSh(), ['-c', command], { cwd, timeout, env: viewEnv.commands(cwd) });
}

async function httpGet(source: Extract<Source, { kind: 'http' }>, url: string, timeout: number, body?: string): Promise<{ text: string; json?: unknown }> {
  const res = await fetch(url, {
    method: source.method,
    headers: { accept: 'application/json, text/csv, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'Beluga', ...expandEnv(source.headers ?? {}) },
    ...(source.method === 'POST' ? { body: body ?? source.body ?? '' } : {}),
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  const text = await res.text();
  if (text.length > MAX_OUTPUT) throw new Error('The answer is too big to show');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      return { text, json: JSON.parse(text) };
    } catch {
      // Not JSON after all.
    }
  }
  return { text };
}

/** Header values may name a variable ("Bearer $GITHUB_TOKEN"): it's filled in here, never shown. */
function expandEnv(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => envValue(name) ?? m)]));
}

function run(cmd: string, args: readonly string[], opts: { cwd?: string; timeout: number; env?: Record<string, string> }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: ownGroup(),
      windowsHide: true,
      env: { ...process.env, ...opts.env, NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', CI: '1' },
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let over = false;
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > MAX_OUTPUT) {
        over = true;
        kill();
      } else out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)));
    const kill = (): void => killTree(child);
    const timer = setTimeout(() => {
      kill();
      reject(new Error(`Took longer than ${Math.round(opts.timeout / 1000)}s`));
    }, opts.timeout);
    timer.unref?.();
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `${cmd} isn’t installed` : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (over) return reject(new Error('The output is too big to show'));
      const text = Buffer.concat(out).toString('utf8');
      if (code !== 0) return reject(new Error((err.trim() || text.trim()).slice(-600) || `${cmd} stopped with code ${code}`));
      resolve(text);
    });
  });
}

/** What a source does, for an error ("Couldn't load …"). */
export const sourceLabel = describeSource;
