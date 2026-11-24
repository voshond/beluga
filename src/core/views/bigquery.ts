import { createSign } from 'node:crypto';
import type { Cell, Row, Source, ViewQuery } from '../../shared/view-spec.js';
import { varName } from './database-url.js';

/**
 * BigQuery for views and sentinels: a service account's key (its JSON, kept as one of your
 * variables, Settings › Environment) signs a token here, and queries go to BigQuery's REST API.
 * Read-only: each query is dry-run first and runs only when it is a SELECT, and it may bill at
 * most its cap (1 GB unless the source says more). Errors never carry the key or a token.
 */

/** Names a service account's key usually goes by, most likely first. */
export const BIGQUERY_KEY_NAMES = ['GOOGLE_APPLICATION_CREDENTIALS_JSON', 'BIGQUERY_CREDENTIALS', 'BIGQUERY_KEY', 'GCP_SERVICE_ACCOUNT_KEY'] as const;
export const DEFAULT_MAX_GB = 1;

const API = 'https://bigquery.googleapis.com/bigquery/v2';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/bigquery';
const WHERE = 'Settings › Environment, or the project’s .env';

export interface BigqueryKey {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly projectId?: string;
  readonly tokenUri: string;
}
export type FoundKey = { readonly key: BigqueryKey; readonly from: string } | { readonly problem: string };
type Env = Readonly<Record<string, string | undefined>>;
type BigquerySource = Extract<Source, { kind: 'bigquery' }>;

/** The key a source uses: the variable it names, else the first one found under a usual name. */
export function bigqueryKey(env: Env, name?: string): FoundKey {
  if (name) {
    const value = env[name]?.trim();
    if (!value) return { problem: `${varName(name)} isn’t set (add the service account’s key JSON in ${WHERE})` };
    return keyOf(value, varName(name));
  }
  for (const key of BIGQUERY_KEY_NAMES) {
    const value = env[key]?.trim();
    if (value) return keyOf(value, varName(key));
  }
  return { problem: `No BigQuery key found: add the service account’s key JSON as ${varName(BIGQUERY_KEY_NAMES[0])} in ${WHERE}` };
}

function keyOf(value: string, from: string): FoundKey {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    raw = parsed as Record<string, unknown>;
  } catch {
    return { problem: `${from} isn’t a service account’s key: paste the whole JSON file Google Cloud gave you` };
  }
  const text = (k: string): string | undefined => (typeof raw[k] === 'string' && raw[k] ? (raw[k] as string) : undefined);
  const clientEmail = text('client_email');
  const privateKey = text('private_key');
  if (raw.type !== undefined && raw.type !== 'service_account') return { problem: `${from} is a ${String(raw.type)} key: BigQuery here takes a service account’s key` };
  if (!clientEmail || !privateKey) return { problem: `${from} has no client_email or private_key: paste the whole service account key JSON` };
  const projectId = text('project_id');
  return { key: { clientEmail, privateKey: privateKey.replace(/\\n/g, '\n'), tokenUri: text('token_uri') ?? TOKEN_URI, ...(projectId ? { projectId } : {}) }, from };
}

// ---------------------------------------------------------------- tokens

const base64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** A signed request for a token (RFC 7523): what Google's token address trades for an access token. */
export function signedAssertion(key: BigqueryKey, now = Math.floor(Date.now() / 1000)): string {
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: key.clientEmail, scope: SCOPE, aud: key.tokenUri, iat: now, exp: now + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${claims}`);
  let signature: string;
  try {
    signature = signer.sign(key.privateKey, 'base64url');
  } catch {
    throw new Error('The service account’s private_key can’t sign: paste the key JSON again, whole');
  }
  return `${head}.${claims}.${signature}`;
}

const tokens = new Map<string, { readonly token: string; readonly until: number }>();

async function accessToken(key: BigqueryKey, timeout: number): Promise<string> {
  const kept = tokens.get(key.clientEmail);
  if (kept && kept.until > Date.now()) return kept.token;
  const res = await fetch(key.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(key) }).toString(),
    signal: AbortSignal.timeout(timeout),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google refused the service account (${key.clientEmail}): ${body.error_description ?? body.error ?? `${res.status} ${res.statusText}`}`);
  tokens.set(key.clientEmail, { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 120) * 1000 });
  return body.access_token;
}

/** Forget kept tokens (tests, a key changed). */
export const forgetTokens = (): void => tokens.clear();

// ---------------------------------------------------------------- queries

interface Field {
  readonly name: string;
  readonly type: string;
  readonly mode?: string;
  readonly fields?: readonly Field[];
}
type Value = { readonly v: unknown };
interface QueryResponse {
  readonly jobComplete?: boolean;
  readonly schema?: { readonly fields?: readonly Field[] };
  readonly rows?: ReadonlyArray<{ readonly f: readonly Value[] }>;
  readonly pageToken?: string;
  readonly jobReference?: { readonly jobId: string; readonly location?: string };
}
interface DryRun {
  readonly statistics?: { readonly totalBytesProcessed?: string; readonly query?: { readonly statementType?: string } };
}

const GB = 1e9;
const capOf = (source: { readonly maxGb?: number }): number => Math.round((source.maxGb ?? DEFAULT_MAX_GB) * GB);
const gb = (bytes: number): string => `${(bytes / GB).toFixed(bytes < 10 * GB ? 2 : 0)} GB`;

export interface BigqueryRun {
  readonly key: BigqueryKey;
  /** Which variable the key came from, as error text shows it. */
  readonly from: string;
  readonly project: string;
  readonly location?: string;
  readonly cap: number;
}

/** What a source runs with: its key, the project billed, where the data is and the cap. */
export function bigqueryRun(source: BigquerySource, env: Env): BigqueryRun | { readonly problem: string } {
  const found = bigqueryKey(env, source.env);
  if ('problem' in found) return found;
  const project = source.project ?? found.key.projectId;
  if (!project) return { problem: `${found.from} has no project_id: say which project in the source (project)` };
  return { key: found.key, from: found.from, project, cap: capOf(source), ...(source.location ? { location: source.location } : {}) };
}

async function call<T>(run: BigqueryRun, method: 'GET' | 'POST', url: string, body: unknown, deadline: number): Promise<T> {
  const left = Math.max(1000, deadline - Date.now());
  const token = await accessToken(run.key, left);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(left),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `BigQuery answered ${res.status} ${res.statusText}`);
  return json;
}

/** A dry run: refused unless it only reads, and over its cap before it costs anything. → the bytes it would read. */
export async function checkQuery(run: BigqueryRun, sql: string, deadline: number): Promise<number> {
  const job = await call<DryRun>(run, 'POST', `${API}/projects/${encodeURIComponent(run.project)}/jobs`, {
    configuration: { dryRun: true, query: { query: sql, useLegacySql: false } },
    ...(run.location ? { jobReference: { projectId: run.project, location: run.location } } : {}),
  }, deadline);
  const kind = job.statistics?.query?.statementType;
  if (kind !== 'SELECT') throw new Error(`Only queries that read run here (this one is ${kind ?? 'not a SELECT'})`);
  const bytes = Number(job.statistics?.totalBytesProcessed ?? 0);
  if (bytes > run.cap) throw new Error(`This query would read ${gb(bytes)}, over its limit of ${gb(run.cap)}: filter on the table’s partition column, select fewer columns, or raise maxGb`);
  return bytes;
}

/** Run a query read-only and bring back its rows (at most `max`). */
export async function queryBigquery(run: BigqueryRun, sql: string, timeout: number, max: number): Promise<Row[]> {
  const deadline = Date.now() + timeout;
  await checkQuery(run, sql, deadline);
  const project = encodeURIComponent(run.project);
  let res = await call<QueryResponse>(run, 'POST', `${API}/projects/${project}/queries`, {
    query: sql,
    useLegacySql: false,
    maximumBytesBilled: String(run.cap),
    timeoutMs: Math.max(1000, deadline - Date.now() - 1000),
    maxResults: Math.min(max, 10_000),
    ...(run.location ? { location: run.location } : {}),
  }, deadline);
  const job = res.jobReference;
  const more = (pageToken?: string): Promise<QueryResponse> => {
    if (!job) throw new Error('BigQuery didn’t say which job ran');
    const params = new URLSearchParams({ timeoutMs: String(Math.max(1000, deadline - Date.now() - 1000)), maxResults: String(Math.min(max, 10_000)) });
    if (pageToken) params.set('pageToken', pageToken);
    if (job.location ?? run.location) params.set('location', (job.location ?? run.location)!);
    return call<QueryResponse>(run, 'GET', `${API}/projects/${project}/queries/${encodeURIComponent(job.jobId)}?${params}`, undefined, deadline);
  };
  while (!res.jobComplete) {
    if (Date.now() >= deadline) throw new Error(`Took longer than ${Math.round(timeout / 1000)}s`);
    res = await more();
  }
  const fields = res.schema?.fields ?? [];
  const rows = (res.rows ?? []).map((r) => rowOf(fields, r.f));
  let token = res.pageToken;
  while (token && rows.length < max) {
    const page = await more(token);
    rows.push(...(page.rows ?? []).map((r) => rowOf(fields, r.f)));
    token = page.pageToken;
  }
  return rows.slice(0, max);
}

/** Settings › Environment's Test connection: the key found, a token, and a dry run. → who it is, or what went wrong. */
export async function testBigquery(place: { readonly vars: Record<string, string>; readonly where: string }): Promise<{ ok: true; from: string } | { ok: false; message: string }> {
  const run = bigqueryRun({ kind: 'bigquery', query: 'SELECT 1' }, { ...process.env, ...place.vars });
  if ('problem' in run) return { ok: false, message: `${run.problem}. Looked in ${place.where}.` };
  try {
    await checkQuery(run, 'SELECT 1', Date.now() + 15_000);
    return { ok: true, from: `${run.from} (${run.key.clientEmail}, project ${run.project})` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------- rows

/** A row of BigQuery's answer ({ f: [{ v }] }) as cells: numbers, booleans and times as such, records and lists as JSON. */
export function rowOf(fields: readonly Field[], values: readonly Value[]): Row {
  return Object.fromEntries(fields.map((field, i) => [field.name, cellOf(field, values[i]?.v ?? null)]));
}

function cellOf(field: Field, v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (field.mode === 'REPEATED' || field.type === 'RECORD' || field.type === 'STRUCT' || field.type === 'JSON') return JSON.stringify(plainOf(field, v));
  return scalarOf(field.type, v);
}

function plainOf(field: Field, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (field.mode === 'REPEATED') return Array.isArray(v) ? v.map((item: Value) => plainOf({ ...field, mode: 'NULLABLE' }, item.v)) : [];
  if (field.type === 'RECORD' || field.type === 'STRUCT') {
    const f = (v as { f?: readonly Value[] }).f ?? [];
    return Object.fromEntries((field.fields ?? []).map((sub, i) => [sub.name, plainOf(sub, f[i]?.v ?? null)]));
  }
  if (field.type === 'JSON' && typeof v === 'string') {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  }
  return scalarOf(field.type, v);
}

function scalarOf(type: string, v: unknown): Cell {
  const text = String(v);
  switch (type) {
    case 'INTEGER':
    case 'INT64': {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : text;
    }
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC': {
      const n = Number(text);
      return Number.isFinite(n) ? n : text;
    }
    case 'BOOLEAN':
    case 'BOOL':
      return text === 'true';
    case 'TIMESTAMP': {
      const seconds = Number(text);
      return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : text;
    }
    default:
      return text;
  }
}

// ---------------------------------------------------------------- SQL in BigQuery's words

export const bqIdent = (k: string): string => `\`${k.replace(/[\\`]/g, '\\$&')}\``;
export const bqText = (s: string): string => `'${s.replace(/[\\']/g, '\\$&')}'`;
export const bqLiteral = (v: string): string => (/^-?\d+(\.\d+)?$/.test(v) ? v : bqText(v));
const bqValue = (v: Cell): string => (typeof v === 'number' ? String(v) : typeof v === 'boolean' ? String(v).toUpperCase() : v === null ? 'NULL' : bqText(v));
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, '\\$&');
const contains = (expr: string, needle: string): string => `LOWER(${expr}) LIKE ${bqText(`%${likeEscape(needle.toLowerCase())}%`)}`;
const asText = (k: string): string => `CAST(${bqIdent(k)} AS STRING)`;
const SQL_OP: Readonly<Record<string, string>> = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** The column of the page query that says how many rows match in all (dropped from the rows). */
export const TOTAL_COLUMN = '__beluga_total';

/**
 * One page of a query, searched, filtered, sorted and cut in BigQuery: one query, with how many
 * match in all as a window count (a second count query would read the tables again).
 */
export function bigqueryPageSql(inner: string, q: ViewQuery): string {
  const parts: string[] = [];
  const needle = q.search?.trim();
  if (needle) parts.push(contains('TO_JSON_STRING(s)', needle));
  for (const [k, v] of Object.entries(q.filters ?? {})) if (v.trim()) parts.push(contains(asText(k), v.trim()));
  for (const c of q.where ?? []) {
    if (c.op === 'contains') parts.push(contains(asText(c.key), String(c.value ?? '')));
    else if (c.op === 'in') parts.push(Array.isArray(c.value) && c.value.length ? `${bqIdent(c.key)} IN (${c.value.map(bqValue).join(', ')})` : 'FALSE');
    else if (!Array.isArray(c.value)) parts.push(`${bqIdent(c.key)} ${SQL_OP[c.op]} ${bqValue(c.value)}`);
  }
  const where = parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  const order = q.sort ? ` ORDER BY ${bqIdent(q.sort.key)} ${q.sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST` : '';
  const sel = `SELECT * FROM (${inner}) s${where}${order}`;
  const kept = q.top ? `SELECT * FROM (${sel} LIMIT ${q.top}) s${order}` : sel;
  return `SELECT *, COUNT(*) OVER () AS ${TOTAL_COLUMN} FROM (${kept}) s${order} LIMIT ${q.limit} OFFSET ${q.offset}`;
}
