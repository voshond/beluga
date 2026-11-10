import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PhoneCalls } from '../src/companion/calls.js';
import { PHONE, phoneMay } from '../src/companion/coverage.js';
import { DeviceBook } from '../src/companion/devices.js';
import { CompanionHost } from '../src/companion/host.js';
import { Store, initialState } from '../src/core/store.js';
import { API, METHODS } from '../src/ipc/api.js';
import { generateIdentity } from '../src/net/crypto.js';

/**
 * Every API method is either the phone's or only the Mac's (src/companion/coverage.ts), and the
 * phone's side of the link stays runnable in Bare (no Node builtins, only the packages hyperdht brings).
 */

describe('what the phone may call', () => {
  it('classifies every API method, and nothing else', () => {
    expect(METHODS.filter((m) => PHONE[m] !== 'phone' && PHONE[m] !== 'mac')).toEqual([]);
    expect(Object.keys(PHONE).filter((m) => !(METHODS as string[]).includes(m))).toEqual([]);
  });

  it('keeps code, git, terminals, settings, files by path and hosting on the Mac', () => {
    const macOnly = /^(git|terminals|env|workbench|diff|shell|files|projects|local|stripe|revenuecat|invites|sharing|remote|view|daemon|people)\./;
    // Answering someone at the door is an exception: it's an answer, like an approval. So is picking a
    // conversation's agent (BLG-446): the composer's picker, the phone's too.
    expect(METHODS.filter((m) => macOnly.test(m) && PHONE[m] === 'phone').sort()).toEqual(['invites.decline', 'invites.letIn', 'workbench.setAgent', 'workbench.setModel']);
    for (const m of ['session.setPrefs', 'session.newInviteLink', 'session.setRoomOpen', 'workspaces.merge', 'workspaces.commit', 'agent.step', 'claudeCode.step', 'plans.edit', 'board.update', 'companion.pair.start', 'companion.devices.remove'] as const) expect(PHONE[m]).toBe('mac');
    for (const m of ['companion.ask', 'companion.post', 'companion.askPerson', 'companion.signOut', 'network.groups.approve', 'session.submit', 'host.answerApproval', 'host.stopRun', 'questions.answer', 'gateway.decide', 'gateway.confirm', 'plans.approve', 'plans.pass', 'network.dm.send', 'network.post', 'workspaces.startChat', 'companion.older', 'workspaces.startWorktree', 'plans.create'] as const) expect(PHONE[m]).toBe('phone');
    // BLG-42: a worktree's files (read-only, through the file gate) and terminals (shared with the Mac) are the phone's own methods; the Mac's own stay the Mac's.
    for (const m of ['companion.files.list', 'companion.files.find', 'companion.files.read', 'companion.terminals', 'companion.termOpen', 'companion.termClose'] as const) expect(PHONE[m]).toBe('phone');
    for (const m of ['terminals.shell', 'terminals.global', 'terminals.close', 'files.save', 'files.format', 'files.read', 'files.open'] as const) expect(PHONE[m]).toBe('mac');
    expect(phoneMay('no.such')).toBe(false);
    expect(phoneMay('toString')).toBe(false);
  });

  it('is refused by the host before the API sees it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-coverage-'));
    const called: string[] = [];
    const host = new CompanionHost({
      identity: generateIdentity(),
      store: new Store(initialState('room')),
      devices: new DeviceBook(path.join(dir, 'devices.json')),
      call: async (_c, method) => {
        called.push(method);
        return { ok: true };
      },
      macName: () => 'Mac',
      version: '1',
      thumbsDir: dir,
    });
    const link = { clientId: 'phone:test' } as never;
    for (const m of METHODS.filter((x) => PHONE[x] === 'mac')) {
      const out = await host.phoneCall(link, m, []);
      expect(out).toEqual({ ok: false, error: `${m} is only on your Mac` });
    }
    expect(called).toEqual([]);
    expect(await host.phoneCall(link, 'questions.pick', ['q', 'Q', 'A'])).toEqual({ ok: true });
    expect(called).toEqual(['questions.pick']);
    rmSync(dir, { recursive: true, force: true });
  });
});

const NODE = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
/** What runs in the phone's Bare worklet may use only these (hyperdht brings the rest). */
const PHONE_PACKAGES = new Set(['zod', 'hyperdht', '@hyperswarm/secret-stream', 'sodium-universal', 'b4a', 'streamx']);

function runtimeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^'";]*?\s*from\s*['"]([^'"]+)['"]/gm)].filter((m) => !m[1]).map((m) => m[2]!);
}

function graph(entry: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  const abs = path.resolve(entry);
  if (seen.has(abs)) return seen;
  const imports = runtimeImports(abs);
  seen.set(abs, imports);
  for (const spec of imports) if (spec.startsWith('.')) graph(path.resolve(path.dirname(abs), spec.replace(/\.js$/, '.ts')), seen);
  return seen;
}

describe('the typed list of the phone’s calls', () => {
  it('is exactly the phone methods, with the API’s own argument checks', () => {
    const phone = METHODS.filter((m) => PHONE[m] === 'phone').sort();
    expect(Object.keys(PhoneCalls).sort()).toEqual(phone);
    for (const m of Object.keys(PhoneCalls) as Array<keyof typeof PhoneCalls>) expect(PhoneCalls[m].args).toBe(API[m].args);
    expect(PhoneCalls['companion.ask'].args.safeParse([{ target: { project: 'p1' }, text: 'hi' }]).success).toBe(true);
    expect(PhoneCalls['companion.ask'].args.safeParse([{ target: { project: 'p1' }, text: ' ' }]).success).toBe(false);
    expect(PhoneCalls['companion.ask'].result.parse({ topic: 'conv:ws:w1' })).toEqual({ topic: 'conv:ws:w1' });
  });

  it('is browser-safe: zod and the API list only', () => {
    const g = graph('src/companion/calls.ts');
    const offenders = [...g.entries()].flatMap(([file, imports]) => imports.filter((s) => !s.startsWith('.') && s !== 'zod').map((s) => `${path.relative(process.cwd(), file).replaceAll(path.sep, '/')} → ${s}`));
    expect(offenders).toEqual([]);
  });
});

describe('the phone side runs in Bare', () => {
  it('client.ts and protocol.ts need nothing from Node', () => {
    const g = new Map<string, string[]>();
    graph('src/companion/client.ts', g);
    graph('src/companion/protocol.ts', g);
    graph('src/companion/diagnose.ts', g);
    const files = [...g.keys()].map((f) => path.relative(process.cwd(), f).replaceAll(path.sep, '/')).sort();
    expect(files).toEqual(['src/companion/client.ts', 'src/companion/device-crypto.ts', 'src/companion/diagnose.ts', 'src/companion/dial.ts', 'src/companion/protocol.ts']);
    const offenders = [...g.entries()].flatMap(([file, imports]) => imports.filter((s) => !s.startsWith('.') && (NODE.has(s) || !PHONE_PACKAGES.has(s))).map((s) => `${file} → ${s}`));
    expect(offenders).toEqual([]);
    // Bare has no global Buffer or process: b4a and plain timers only.
    for (const file of g.keys()) expect(readFileSync(file, 'utf8')).not.toMatch(/\bBuffer\.|\bprocess\./);
  });

  it('protocol.ts is zod only', () => {
    expect(runtimeImports('src/companion/protocol.ts')).toEqual(['zod']);
  });
});
