import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOTAL_COLUMN,
  bigqueryKey,
  bigqueryPageSql,
  bigqueryRun,
  bqLiteral,
  forgetTokens,
  queryBigquery,
  rowOf,
  signedAssertion,
  testBigquery,
} from '../src/core/views/bigquery.js';
import { SourceSchema } from '../src/shared/view-spec.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY_JSON = JSON.stringify({ type: 'service_account', project_id: 'acme-dw', client_email: 'beluga@acme-dw.iam.gserviceaccount.com', private_key: PEM, token_uri: 'https://oauth2.googleapis.com/token' });
const TOKEN = 'ya29.secret-access-token';

type Call = { readonly url: string; readonly method: string; readonly body: string | undefined };

/** Google's token address and BigQuery, as `answer` says for each call after the token. */
function stubGoogle(answer: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: string }) => {
    const call = { url, method: init.method, body: init.body };
    calls.push(call);
    if (url.startsWith('https://oauth2.googleapis.com/')) return Response.json({ access_token: TOKEN, expires_in: 3600 });
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out);
  });
  return calls;
}

const dryRun = (statementType: string, bytes = 1000) => ({ statistics: { totalBytesProcessed: String(bytes), query: { statementType } } });
const isDryRun = (call: Call): boolean => call.url.endsWith('/jobs') && call.method === 'POST';

beforeEach(() => forgetTokens());
afterEach(() => vi.unstubAllGlobals());

describe('bigqueryKey', () => {
  it('finds the key under a usual name, or the one a source names', () => {
    const found = bigqueryKey({ GOOGLE_APPLICATION_CREDENTIALS_JSON: KEY_JSON });
    expect(found).toMatchObject({ from: '`$GOOGLE_APPLICATION_CREDENTIALS_JSON`', key: { clientEmail: 'beluga@acme-dw.iam.gserviceaccount.com', projectId: 'acme-dw' } });
    expect(bigqueryKey({ WAREHOUSE: KEY_JSON }, 'WAREHOUSE')).toMatchObject({ from: '`$WAREHOUSE`' });
    expect(bigqueryKey({}, 'WAREHOUSE')).toEqual({ problem: expect.stringContaining('`$WAREHOUSE` isn’t set') });
    expect(bigqueryKey({})).toEqual({ problem: expect.stringContaining('No BigQuery key found') });
  });

  it('says what is wrong with a key without showing it', () => {
    const broken = bigqueryKey({ GOOGLE_APPLICATION_CREDENTIALS_JSON: `{"private_key": "${'x'.repeat(40)}"` });
    expect(broken).toEqual({ problem: expect.stringContaining('isn’t a service account’s key') });
    expect(JSON.stringify(broken)).not.toContain('xxxxxxxx');
    const user = bigqueryKey({ GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({ type: 'authorized_user', client_id: 'a', refresh_token: 'secret' }) });
    expect(user).toEqual({ problem: expect.stringContaining('authorized_user') });
    expect(JSON.stringify(user)).not.toContain('secret');
  });

  it('bills the source’s project, else the key’s, capped at 1 GB unless it says more', () => {
    const env = { GOOGLE_APPLICATION_CREDENTIALS_JSON: KEY_JSON };
    expect(bigqueryRun({ kind: 'bigquery', query: 'SELECT 1' }, env)).toMatchObject({ project: 'acme-dw', cap: 1e9 });
    expect(bigqueryRun({ kind: 'bigquery', query: 'SELECT 1', project: 'other-proj', maxGb: 5, location: 'EU' }, env)).toMatchObject({ project: 'other-proj', cap: 5e9, location: 'EU' });
  });
});

describe('signedAssertion', () => {
  it('is a JWT for BigQuery, signed with the service account’s key', () => {
    const found = bigqueryKey({ GOOGLE_APPLICATION_CREDENTIALS_JSON: KEY_JSON });
    if ('problem' in found) throw new Error(found.problem);
    const jwt = signedAssertion(found.key, 1_700_000_000);
    const [head, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      iss: 'beluga@acme-dw.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/bigquery',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const verify = createVerify('RSA-SHA256');
    verify.update(`${head}.${claims}`);
    expect(verify.verify(publicKey, signature!, 'base64url')).toBe(true);
  });
});

describe('rowOf', () => {
  it('turns BigQuery’s cells into numbers, booleans, times and JSON', () => {
    const fields = [
      { name: 'id', type: 'INTEGER' },
      { name: 'big', type: 'INT64' },
      { name: 'price', type: 'NUMERIC' },
      { name: 'ok', type: 'BOOLEAN' },
      { name: 'at', type: 'TIMESTAMP' },
      { name: 'day', type: 'DATE' },
      { name: 'tags', type: 'STRING', mode: 'REPEATED' },
      { name: 'who', type: 'RECORD', fields: [{ name: 'name', type: 'STRING' }, { name: 'age', type: 'INTEGER' }] },
      { name: 'none', type: 'STRING' },
    ];
    const row = rowOf(fields, [
      { v: '42' },
      { v: '9223372036854775807' },
      { v: '19.99' },
      { v: 'true' },
      { v: '1.7E9' },
      { v: '2026-11-25' },
      { v: [{ v: 'a' }, { v: 'b' }] },
      { v: { f: [{ v: 'Mia' }, { v: '31' }] } },
      { v: null },
    ]);
    expect(row).toEqual({
      id: 42,
      big: '9223372036854775807',
      price: 19.99,
      ok: true,
      at: '2023-11-14T22:13:20.000Z',
      day: '2026-11-25',
      tags: '["a","b"]',
      who: '{"name":"Mia","age":31}',
      none: null,
    });
  });
});

describe('bigqueryPageSql', () => {
  it('searches, filters, sorts and pages in BigQuery’s words, counting in the same query', () => {
    const sql = bigqueryPageSql('SELECT * FROM `acme.sales.orders`', {
      offset: 50,
      limit: 25,
      search: "O'Brien_%",
      sort: { key: 'created at', dir: 'desc' },
      where: [{ key: 'status', op: 'in', value: ['paid', 'refunded'] }, { key: 'total', op: 'gte', value: 10 }],
    });
    expect(sql).toContain("LOWER(TO_JSON_STRING(s)) LIKE '%o\\'brien\\\\_\\\\%%'");
    expect(sql).toContain("`status` IN ('paid', 'refunded')");
    expect(sql).toContain('`total` >= 10');
    expect(sql).toContain('ORDER BY `created at` DESC NULLS LAST');
    expect(sql).toContain(`COUNT(*) OVER () AS ${TOTAL_COLUMN}`);
    expect(sql.endsWith('LIMIT 25 OFFSET 50')).toBe(true);
  });

  it('quotes a control’s value for BigQuery', () => {
    expect(bqLiteral("it's")).toBe("'it\\'s'");
    expect(bqLiteral('12.5')).toBe('12.5');
  });
});

describe('queryBigquery', () => {
  const run = () => {
    const r = bigqueryRun({ kind: 'bigquery', query: 'x' }, { GOOGLE_APPLICATION_CREDENTIALS_JSON: KEY_JSON });
    if ('problem' in r) throw new Error(r.problem);
    return r;
  };

  it('dry-runs first, then runs with the cap and follows pages', async () => {
    const calls = stubGoogle((call) => {
      if (isDryRun(call)) return dryRun('SELECT');
      if (call.method === 'POST') return { jobComplete: true, schema: { fields: [{ name: 'n', type: 'INTEGER' }] }, rows: [{ f: [{ v: '1' }] }], pageToken: 'p2', jobReference: { jobId: 'job_1', location: 'EU' } };
      return { jobComplete: true, rows: [{ f: [{ v: '2' }] }] };
    });
    expect(await queryBigquery(run(), 'SELECT n FROM t', 10_000, 100)).toEqual([{ n: 1 }, { n: 2 }]);
    const query = calls.find((c) => c.url.endsWith('/queries'))!;
    expect(JSON.parse(query.body!)).toMatchObject({ useLegacySql: false, maximumBytesBilled: '1000000000' });
    expect(calls.at(-1)!.url).toContain('/queries/job_1?');
    expect(calls.at(-1)!.url).toContain('pageToken=p2');
    expect(calls.at(-1)!.url).toContain('location=EU');
  });

  it('refuses anything but a SELECT before it runs', async () => {
    const calls = stubGoogle((call) => (isDryRun(call) ? dryRun('DELETE') : { jobComplete: true }));
    await expect(queryBigquery(run(), 'DELETE FROM t WHERE true', 10_000, 100)).rejects.toThrow('Only queries that read run here (this one is DELETE)');
    expect(calls.some((c) => c.url.endsWith('/queries'))).toBe(false);
  });

  it('refuses a query that would read over its cap, saying how much', async () => {
    stubGoogle((call) => (isDryRun(call) ? dryRun('SELECT', 4.2e9) : { jobComplete: true }));
    await expect(queryBigquery(run(), 'SELECT * FROM huge', 10_000, 100)).rejects.toThrow('would read 4.20 GB, over its limit of 1.00 GB');
  });

  it('never shows the key or the token in an error', async () => {
    stubGoogle(() => Response.json({ error: { message: 'Access Denied: Table acme:sales.orders' } }, { status: 403 }));
    const err = await queryBigquery(run(), 'SELECT 1', 10_000, 100).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Access Denied: Table acme:sales.orders');
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain('PRIVATE KEY');
  });
});

describe('testBigquery', () => {
  it('names the variable, the service account and the project when it works', async () => {
    stubGoogle(() => dryRun('SELECT', 0));
    expect(await testBigquery({ vars: { GOOGLE_APPLICATION_CREDENTIALS_JSON: KEY_JSON }, where: 'your variables' })).toEqual({
      ok: true,
      from: '`$GOOGLE_APPLICATION_CREDENTIALS_JSON` (beluga@acme-dw.iam.gserviceaccount.com, project acme-dw)',
    });
  });

  it('says what is missing and where it looked', async () => {
    const saved = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    expect(await testBigquery({ vars: {}, where: 'your variables' })).toEqual({ ok: false, message: expect.stringContaining('Looked in your variables.') });
    if (saved !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = saved;
  });
});

describe('a bigquery source', () => {
  it('parses as views and sentinels write it', () => {
    expect(SourceSchema.parse({ kind: 'bigquery', query: 'SELECT 1', maxGb: 5, location: 'EU' })).toEqual({ kind: 'bigquery', query: 'SELECT 1', maxGb: 5, location: 'EU' });
    expect(SourceSchema.safeParse({ kind: 'bigquery', query: 'SELECT 1', maxGb: 5000 }).success).toBe(false);
  });
});
