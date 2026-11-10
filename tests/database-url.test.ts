import { describe, expect, it } from 'vitest';
import {
  SUPABASE_REGIONS,
  classifyPgError,
  databaseUrl,
  hidePassword,
  parsePgUrl,
  poolerCandidates,
  poolerUrl,
  scrubbed,
  supabaseRef,
  supabaseRefOf,
  unreachable,
  withPassword,
} from '../src/core/views/database-url.js';
import { secretIn } from '../src/shared/secret-text.js';

const REF = 'abcdefghijklmnopqrst';

describe('databaseUrl', () => {
  it('uses the variable a view names, and only for a Postgres connection string', () => {
    expect(databaseUrl({ MY_DB: 'postgres://u:p@h/db' }, 'MY_DB')).toEqual({ url: 'postgres://u:p@h/db', from: '`$MY_DB`' });
    expect(databaseUrl({}, 'MY_DB')).toEqual({ problem: expect.stringContaining('`$MY_DB` isn’t set') });
    // A token under that name never goes to psql (its error could show it).
    const wrong = databaseUrl({ STRIPE_KEY: 'sk_live_123' }, 'STRIPE_KEY');
    expect(wrong).toEqual({ problem: expect.stringContaining('isn’t a Postgres connection URL') });
    expect(JSON.stringify(wrong)).not.toContain('sk_live_123');
  });

  it('finds the usual names by itself', () => {
    expect(databaseUrl({ POSTGRES_URL: 'postgresql://x' })).toEqual({ url: 'postgresql://x', from: '`$POSTGRES_URL`' });
    expect(databaseUrl({ DATABASE_URL: 'mysql://x', DIRECT_URL: 'postgres://y' })).toEqual({ url: 'postgres://y', from: '`$DIRECT_URL`' });
    expect(databaseUrl({})).toEqual({ problem: expect.stringContaining('No database found') });
  });

  it('keeps the underscores of variable names in what it says (inline code, so Markdown leaves them)', () => {
    const got = databaseUrl({}, 'DATABASE_POOLER_URL');
    expect(got).toEqual({ problem: expect.stringContaining('`$DATABASE_POOLER_URL`') });
  });

  it('says a DATABASE_URL holding only a host name is no connection string, rather than quietly using Supabase’s variables', () => {
    const env = { DATABASE_URL: `db.${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, SUPABASE_DB_PASSWORD: 'pw' };
    const got = databaseUrl(env);
    expect(got).toEqual({ problem: expect.stringContaining('`$DATABASE_URL` holds a host name, not a connection URL') });
    // Never the value itself.
    expect(JSON.stringify(got)).not.toContain(`db.${REF}`);
  });

  it("makes Supabase's connection string from its variables", () => {
    const env = { NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJ…' };
    expect(supabaseRef(env)).toBe(REF);
    // The API keys don't open the database: it says what's missing, and where to find it.
    const missing = databaseUrl(env);
    expect(missing).toEqual({ problem: expect.stringContaining('SUPABASE_DB_PASSWORD') });
    // Without the region, the direct address, and the project so its pooler can be looked for.
    expect(databaseUrl({ ...env, SUPABASE_DB_PASSWORD: 'p@ss/w' })).toMatchObject({ url: `postgresql://postgres:p%40ss%2Fw@db.${REF}.supabase.co:5432/postgres`, from: `Supabase (${REF}) and \`$SUPABASE_DB_PASSWORD\``, supabase: { ref: REF } });
    // With the region, the session poolers (they work on every network): aws-0, then aws-1.
    expect(databaseUrl({ ...env, SUPABASE_DB_PASSWORD: 'pw', SUPABASE_REGION: 'eu-central-1' })).toMatchObject({
      url: `postgresql://postgres.${REF}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`,
      more: [`postgresql://postgres.${REF}:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`],
    });
    // A connection string of its own wins.
    expect(databaseUrl({ ...env, DATABASE_URL: 'postgres://own' })).toMatchObject({ url: 'postgres://own' });
    expect(supabaseRef({ SUPABASE_PROJECT_REF: REF })).toBe(REF);
    expect(supabaseRef({ SUPABASE_URL: 'https://example.com' })).toBeUndefined();
  });
});

describe('a connection string pasted from Supabase', () => {
  it('catches the [YOUR-PASSWORD] left in it', () => {
    expect(databaseUrl({ DATABASE_URL: `postgresql://postgres:[YOUR-PASSWORD]@db.${REF}.supabase.co:5432/postgres` })).toEqual({ problem: expect.stringContaining('[YOUR-PASSWORD]') });
  });

  it("falls back from the direct address to the region's poolers, and knows the project", () => {
    const url = `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
    expect(databaseUrl({ DATABASE_URL: url, SUPABASE_REGION: 'us-east-1' })).toEqual({
      url,
      from: '`$DATABASE_URL`',
      more: [`postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`, `postgresql://postgres.${REF}:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres`],
      supabase: { ref: REF, region: 'us-east-1' },
    });
    // No region: no fallbacks yet, but the project, so the connector finds its pooler by asking.
    expect(databaseUrl({ DATABASE_URL: url })).toEqual({ url, from: '`$DATABASE_URL`', supabase: { ref: REF } });
  });

  it('reads the region from a pooler host another variable holds', () => {
    const url = `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
    const pooled = `postgresql://postgres.${REF}:pw@aws-1-eu-central-1.pooler.supabase.com:6543/postgres`;
    expect(databaseUrl({ DATABASE_URL: url, POSTGRES_PRISMA_URL: pooled })).toMatchObject({ supabase: { ref: REF, region: 'eu-central-1', host: 'aws-1-eu-central-1.pooler.supabase.com' }, more: [`postgresql://postgres.${REF}:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`] });
  });

  it('offers the project’s other password variables, but not the one the string has', () => {
    const url = `postgresql://postgres.${REF}:old@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`;
    expect(databaseUrl({ DATABASE_URL: url, SUPABASE_DB_PASSWORD: 'n3w/pw' })).toMatchObject({ passwords: [{ from: '`$SUPABASE_DB_PASSWORD`', value: 'n3w%2Fpw' }] });
    expect(databaseUrl({ DATABASE_URL: url, SUPABASE_DB_PASSWORD: 'old' })).not.toHaveProperty('passwords');
    // Not a Supabase database: its password variables aren't Supabase's to offer.
    expect(databaseUrl({ DATABASE_URL: 'postgres://u:p@db.example.com/x', SUPABASE_DB_PASSWORD: 'x' })).not.toHaveProperty('passwords');
  });

  it('tells a dead address from an answer', () => {
    expect(unreachable('psql: error: connection to server at "db.x.supabase.co", port 5432 failed: timeout expired')).toBe(true);
    expect(unreachable('psql: error: connection to server at "aws-0-x.pooler.supabase.com" failed: FATAL:  Tenant or user not found')).toBe(true);
    expect(unreachable('psql: error: connection to server failed: FATAL:  password authentication failed for user "postgres"')).toBe(false);
    expect(unreachable('ERROR:  relation "users" does not exist')).toBe(false);
  });
});

describe('Supabase’s poolers (pure parts)', () => {
  const direct = `postgresql://postgres:s3cret@db.${REF}.supabase.co:5432/postgres?sslmode=require`;

  it('reads a connection string, and the project it goes to', () => {
    expect(parsePgUrl(direct)).toEqual({ scheme: 'postgresql', user: 'postgres', password: 's3cret', host: `db.${REF}.supabase.co`, port: '5432', database: 'postgres', query: '?sslmode=require' });
    expect(supabaseRefOf(direct)).toBe(REF);
    expect(supabaseRefOf(`postgresql://postgres.${REF}:x@aws-0-us-east-1.pooler.supabase.com:5432/postgres`)).toBe(REF);
    expect(supabaseRefOf('postgres://u:p@db.example.com/x')).toBeUndefined();
    expect(supabaseRefOf('not a url')).toBeUndefined();
  });

  it('turns the direct address into the pooler’s: user postgres.<ref>, port 5432, the rest kept', () => {
    expect(poolerUrl(direct, REF, 'aws-1-eu-central-1.pooler.supabase.com')).toBe(`postgresql://postgres.${REF}:s3cret@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`);
    expect(withPassword(direct, 'n%2Fw')).toBe(`postgresql://postgres:n%2Fw@db.${REF}.supabase.co:5432/postgres?sslmode=require`);
    expect(hidePassword(direct)).toBe(`postgresql://postgres:[YOUR-PASSWORD]@db.${REF}.supabase.co:5432/postgres?sslmode=require`);
    expect(hidePassword(direct)).not.toContain('s3cret');
  });

  it('lists the poolers to ask: the named host, else its region’s two, else every region’s', () => {
    expect(poolerCandidates({ host: 'aws-1-eu-central-1.pooler.supabase.com' }, false)).toEqual(['aws-1-eu-central-1.pooler.supabase.com']);
    expect(poolerCandidates({ region: 'eu-central-1' }, false)).toEqual(['aws-0-eu-central-1.pooler.supabase.com', 'aws-1-eu-central-1.pooler.supabase.com']);
    const all = poolerCandidates({ region: 'eu-central-1' });
    expect(all.slice(0, 2)).toEqual(['aws-0-eu-central-1.pooler.supabase.com', 'aws-1-eu-central-1.pooler.supabase.com']);
    expect(all).toHaveLength(SUPABASE_REGIONS.length * 2);
    expect(new Set(all).size).toBe(all.length);
  });

  it('classifies what psql says', () => {
    expect(classifyPgError('connection to server at "db.x.supabase.co" (2a05::1), port 5432 failed: timeout expired', direct)).toBe('no-ipv6');
    expect(classifyPgError('could not translate host name "db.x.supabase.co" to address: nodename nor servname provided, or not known', direct)).toBe('no-ipv6');
    expect(classifyPgError('connection to server at "db.example.com" failed: Connection refused', 'postgres://u:p@db.example.com/x')).toBe('unreachable');
    expect(classifyPgError('FATAL:  Tenant or user not found')).toBe('wrong-pooler');
    expect(classifyPgError('FATAL:  password authentication failed for user "postgres"')).toBe('wrong-password');
    expect(classifyPgError('ERROR:  column "admin_id" does not exist')).toBe('other');
  });
});

describe('scrubbed', () => {
  it('takes the connection string and its password out of an error', () => {
    const url = 'postgresql://postgres:hunter2%21@db.x.supabase.co:5432/postgres';
    const out = scrubbed(`connection to ${url} failed; password "hunter2!" rejected`, url);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('postgres://…');
  });
});

describe('secretIn (a message to the room)', () => {
  it('spots a password or key before everyone sees it', () => {
    expect(secretIn('here: postgresql://postgres.abc:Hunter2pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres')).toBe('a connection string with its password');
    expect(secretIn('SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.abc')).toBe('a secret value');
    const rc = ['sk', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('_');
    expect(secretIn(`the RevenueCat key is ${rc}`)).toBe('a RevenueCat secret key');
    expect(secretIn('rename task_name_value please')).toBeUndefined();
    expect(secretIn('my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('an Anthropic API key');
    // Talking about them is fine.
    expect(secretIn('postgresql://postgres:[YOUR-PASSWORD]@db.x.supabase.co/postgres')).toBeUndefined();
    expect(secretIn('set DATABASE_URL in Settings and the password too')).toBeUndefined();
  });
});
