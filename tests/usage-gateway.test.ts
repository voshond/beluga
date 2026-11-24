import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { usagesOf, withUsage } from '../src/agent/usage.js';
import { usageViews } from '../src/companion/views.js';
import { UsageView } from '../src/companion/protocol.js';
import { loadUsageGatewayConfig } from '../src/core/usage-gateway/config.js';
import { GatewayUsageResponse, fromGatewayUsage } from '../src/core/usage-gateway/map.js';
import { type GatewayFetch, UsageGateway } from '../src/core/usage-gateway/poller.js';
import { parseArgs } from '../src/ipc/api.js';
import type { Profile } from '../src/protocol.js';
import { providerCards } from '../src/ui/usage-cards.js';

const KEY = 'usage-read-token-0123456789';
const URL = 'https://ai-gateway.example';
const NOW = Date.parse('2026-09-11T19:00:00Z');
const FIXTURE_TEXT = readFileSync(path.join(import.meta.dirname, 'fixtures', 'gateway-usage-response.json'), 'utf8');

type Usages = Pick<Profile, 'usage' | 'usages'>;
type Call = { readonly url: string; readonly auth?: string };

const fixture = (): GatewayUsageResponse => GatewayUsageResponse.parse(JSON.parse(FIXTURE_TEXT));

const fakeFetch = (answer: () => { status: number; body: string } | Error) => {
  const calls: Call[] = [];
  const fetch: GatewayFetch = async (url, init) => {
    calls.push({ url, ...(init.headers.authorization ? { auth: init.headers.authorization } : {}) });
    const a = answer();
    if (a instanceof Error) throw a;
    return { status: a.status, text: async () => a.body };
  };
  return { fetch, calls };
};

const harness = (answer: () => { status: number; body: string } | Error, file: string | null = null) => {
  let profile: Usages = {};
  const { fetch, calls } = fakeFetch(answer);
  const gateway = new UsageGateway({
    file,
    fetch,
    now: () => NOW,
    report: (agent, update, at) => {
      profile = { ...profile, ...withUsage(profile, agent, update, at) };
    },
    usages: () => usagesOf(profile),
  });
  return { gateway, calls, profile: () => profile, seed: (p: Usages) => (profile = p) };
};

const ok = () => ({ status: 200, body: FIXTURE_TEXT });

describe('mapping ai-gateway usage', () => {
  it('maps Claude and Codex from the gnome-usage fixture', () => {
    const usage = fromGatewayUsage(fixture());
    expect(usage.claude).toEqual({
      served: true,
      fetchedAt: 1789142400_000,
      update: {
        fiveHour: { pct: 19, resetsAt: Date.parse('2026-09-11T21:00:00Z') },
        week: { pct: 42, resetsAt: Date.parse('2026-09-16T12:00:00Z') },
      },
    });
    expect(usage.codex).toEqual({
      served: true,
      fetchedAt: 1789142100_000,
      error: 'Codex usage poll failed: app-server exited',
      update: {
        fiveHour: { pct: 28, resetsAt: 1789153200_000 },
        week: { pct: 64, resetsAt: 1789560000_000 },
        plan: 'plus',
      },
    });
  });

  it('says why a provider has no numbers', () => {
    const usage = fromGatewayUsage(GatewayUsageResponse.parse({ providers: { claude: { fetchedAt: null, usage: null, error: '  token expired  ' } } }));
    expect(usage.claude).toEqual({ served: true, error: 'token expired' });
    expect(usage.codex).toEqual({ served: false, error: 'Codex usage is not enabled on ai-gateway' });
    expect(fromGatewayUsage(GatewayUsageResponse.parse({ providers: { claude: { usage: { five_hour: null } } } })).claude.error).toBe('ai-gateway has no Claude plan windows');
  });

  it('keeps one provider when the other is malformed', () => {
    const usage = fromGatewayUsage(GatewayUsageResponse.parse({ providers: { claude: { usage: { five_hour: { utilization: 'lots' } } }, codex: JSON.parse(FIXTURE_TEXT).providers.codex } }));
    expect(usage.claude.update).toBeUndefined();
    expect(usage.codex.update?.week?.pct).toBe(64);
  });

  it('refuses an answer without providers', () => {
    expect(GatewayUsageResponse.safeParse({ error: 'nope' }).success).toBe(false);
  });
});

describe('the usage gateway', () => {
  it('polls with the key and merges both providers through withUsage', async () => {
    const h = harness(ok);
    h.gateway.configure({ source: 'gateway', url: `${URL}/`, key: KEY });
    await h.gateway.poll();
    expect(h.calls.at(-1)).toEqual({ url: `${URL}/gateway/usage`, auth: `Bearer ${KEY}` });
    const claude = usagesOf(h.profile()).find((u) => u.agent.runtime === 'claude');
    expect(claude).toMatchObject({ via: 'gateway', signedIn: true, fiveHour: { pct: 19 }, week: { pct: 42 }, updatedAt: 1789142400_000 });
    expect(claude?.error).toBeUndefined();
    expect(h.profile().usage).toMatchObject({ fiveHour: { pct: 19 } });
    expect(usagesOf(h.profile()).find((u) => u.agent.runtime === 'codex')).toMatchObject({ via: 'gateway', plan: 'plus', week: { pct: 64 }, error: 'Codex usage poll failed: app-server exited' });
    expect(h.gateway.status()).toEqual({
      source: 'gateway',
      url: URL,
      hasKey: true,
      checkedAt: NOW,
      providers: { claude: { ok: true }, codex: { ok: true, error: 'Codex usage poll failed: app-server exited' } },
    });
    h.gateway.stop();
  });

  it('keeps the last numbers and says why when the gateway is unreachable', async () => {
    let down = false;
    const h = harness(() => (down ? new Error('ECONNREFUSED') : ok()));
    h.gateway.configure({ source: 'gateway', url: URL, key: KEY });
    await h.gateway.poll();
    down = true;
    await h.gateway.poll();
    const claude = usagesOf(h.profile()).find((u) => u.agent.runtime === 'claude');
    expect(claude).toMatchObject({ fiveHour: { pct: 19 }, week: { pct: 42 }, updatedAt: 1789142400_000, error: `Couldn’t refresh from ai-gateway: Couldn’t reach ai-gateway at ${URL}` });
    expect(h.gateway.status().lastError).toBe(`Couldn’t reach ai-gateway at ${URL}`);
    down = false;
    await h.gateway.poll();
    expect(usagesOf(h.profile()).find((u) => u.agent.runtime === 'claude')?.error).toBeUndefined();
    h.gateway.stop();
  });

  it('says a rejected key, never the key itself', async () => {
    const h = harness(() => ({ status: 401, body: '' }));
    h.gateway.configure({ source: 'gateway', url: URL, key: KEY });
    await h.gateway.poll();
    expect(h.gateway.status().lastError).toBe('ai-gateway rejected the key (HTTP 401)');
    expect(JSON.stringify(h.gateway.status())).not.toContain(KEY);
    expect(await h.gateway.check()).toEqual({ ok: false, error: 'ai-gateway rejected the key (HTTP 401)' });
    h.gateway.stop();
  });

  it('adds no card for a provider the gateway does not serve', async () => {
    const h = harness(() => ({ status: 200, body: JSON.stringify({ providers: { claude: JSON.parse(FIXTURE_TEXT).providers.claude } }) }));
    h.gateway.configure({ source: 'gateway', url: URL, key: KEY });
    await h.gateway.poll();
    expect(usagesOf(h.profile()).map((u) => u.agent.runtime)).toEqual(['claude']);
    h.gateway.stop();
  });

  it('only sends the saved key to the saved address', async () => {
    const h = harness(ok);
    h.gateway.configure({ source: 'gateway', url: URL, key: KEY });
    await h.gateway.poll();
    expect(await h.gateway.check({ url: 'https://elsewhere.example' })).toEqual({ ok: false, error: 'Type the ai-gateway usage key first' });
    const checked = await h.gateway.check({ url: 'https://elsewhere.example', key: 'other' });
    expect(checked).toMatchObject({ ok: true, providers: { claude: { ok: true }, codex: { ok: true } } });
    expect(h.calls.at(-1)).toEqual({ url: 'https://elsewhere.example/gateway/usage', auth: 'Bearer other' });
    h.gateway.configure({ url: 'https://moved.example' });
    expect(h.gateway.status().hasKey).toBe(false);
    h.gateway.stop();
  });

  it('does nothing on local, and unmarks the cards when switched back', async () => {
    const h = harness(ok);
    await h.gateway.poll();
    expect(h.calls).toHaveLength(0);
    h.gateway.configure({ source: 'gateway', url: URL, key: KEY });
    await h.gateway.poll();
    h.gateway.configure({ source: 'local' });
    for (const u of usagesOf(h.profile())) {
      expect(u.via).toBeUndefined();
      expect(u.error).toBeUndefined();
    }
    expect(usagesOf(h.profile()).find((u) => u.agent.runtime === 'claude')?.fiveHour?.pct).toBe(19);
  });

  it('keeps the key in its own private file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-gateway-'));
    const file = path.join(dir, 'usage-gateway.json');
    const h = harness(ok, file);
    h.gateway.configure({ source: 'gateway', url: URL, key: KEY });
    h.gateway.stop();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadUsageGatewayConfig(file)).toEqual({ source: 'gateway', url: URL, key: KEY });
  });

  it('validates what the app sends', () => {
    expect(parseArgs('usageGateway.configure', [{ source: 'gateway', url: URL, key: KEY }])).toEqual([{ source: 'gateway', url: URL, key: KEY }]);
    expect(parseArgs('usageGateway.configure', [{ key: null }])).toEqual([{ key: null }]);
    expect(() => parseArgs('usageGateway.configure', [{ url: 'file:///etc/passwd' }])).toThrow();
    expect(() => parseArgs('usageGateway.configure', [{ source: 'cloud' }])).toThrow();
  });
});

describe('cards fed by the gateway', () => {
  it('show without a local sign-in, with their error, on the Mac and the phone', async () => {
    const h = harness(ok);
    h.gateway.configure({ source: 'gateway', url: URL, key: KEY });
    await h.gateway.poll();
    h.gateway.stop();
    const notHere = [
      { id: 'claude', state: 'missing' },
      { id: 'codex', state: 'signed-out' },
    ];
    const cards = providerCards({ ...h.profile(), agents: [] }, undefined, notHere);
    expect(cards.map((c) => [c.key, c.shape, c.signedIn])).toEqual([
      ['claude', 'quota', true],
      ['codex', 'quota', true],
    ]);
    expect(cards[1]?.error).toBe('Codex usage poll failed: app-server exited');
    const views = usageViews({ ...h.profile(), agents: [] }, undefined, notHere);
    expect(views.find((v) => v.runtime === 'codex')?.error).toBe('Codex usage poll failed: app-server exited');
    for (const v of views) expect(UsageView.safeParse(v).success).toBe(true);
  });
});
